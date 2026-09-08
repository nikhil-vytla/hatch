"""Pinned text-only provider contracts and a credential-owning HTTP transport.

No tokenizer guesses: admission reserves the provider's entire documented input
ceiling and the inclusive output ceiling. A profile without those bounds fails.
"""
from collections.abc import Callable
from dataclasses import dataclass
import http.client
import json
from typing import Protocol
from urllib.parse import urlsplit

from ..codec import encode
from ..contracts.primitives import ArtifactRef, Reservation, Resource, ResourceQuantity
from ..errors import VerificationError


def json_object(data: bytes) -> dict[str, object]:
    def unique(pairs: list[tuple[str, object]]) -> dict[str, object]:
        result: dict[str, object] = {}
        for key, value in pairs:
            if key in result:
                raise VerificationError("duplicate JSON key")
            result[key] = value
        return result
    try:
        value: object = json.loads(data, object_pairs_hook=unique,
                                   parse_constant=lambda s: (_ for _ in ()).throw(ValueError(s)))
    except (ValueError, RecursionError) as error:
        raise VerificationError("malformed provider JSON") from error
    if not isinstance(value, dict):
        raise VerificationError("provider object required")
    return value


@dataclass(frozen=True)
class ProviderContract:
    provider: str
    model: str
    endpoint: str
    protocol: str
    account: str
    evidence: ArtifactRef
    input_ceiling: int
    output_ceiling: int
    max_request_bytes: int
    max_response_bytes: int
    input_nanodollars: int
    output_nanodollars: int
    request_nanodollars: int = 0
    inclusive_reasoning_bound: bool = True
    deterministic_decoder: bool = True
    verified_lookup: bool = False
    recovery_key_header: str | None = None
    wall_milliseconds: int = 10000

    def __post_init__(self) -> None:
        if (not self.inclusive_reasoning_bound or min(self.input_ceiling, self.output_ceiling,
                self.max_request_bytes, self.max_response_bytes, self.wall_milliseconds) <= 0
                or min(self.input_nanodollars, self.output_nanodollars, self.request_nanodollars) < 0):
            raise ValueError("provider lacks a defensible whole-generation bound")
        if self.verified_lookup and self.recovery_key_header is None:
            raise ValueError("verified lookup needs a provider-recognized operation key")
        if self.protocol not in {"responses-text/1", "anthropic-text/1"}:
            raise ValueError("unsupported pinned protocol")

    def retained(self) -> bytes:
        return encode(tuple(getattr(self, key) for key in self.__dataclass_fields__))

    def reservation(self, bound_method: ArtifactRef) -> Reservation:
        return Reservation((ResourceQuantity(Resource.INPUT_TOKENS, self.input_ceiling),
                            ResourceQuantity(Resource.OUTPUT_TOKENS, self.output_ceiling),
                            ResourceQuantity(Resource.MODEL_CALLS, 1),
                            ResourceQuantity(Resource.WALL_MILLISECONDS, self.wall_milliseconds),
                            ResourceQuantity(Resource.USD_NANODOLLARS,
                                self.input_ceiling * self.input_nanodollars +
                                self.output_ceiling * self.output_nanodollars + self.request_nanodollars)), bound_method)

    def validate(self, raw: bytes) -> None:
        if len(raw) > self.max_request_bytes:
            raise VerificationError("oversized request")
        request = json_object(raw)
        output_key = "max_output_tokens" if self.protocol == "responses-text/1" else "max_tokens"
        input_key = "input" if self.protocol == "responses-text/1" else "messages"
        allowed = {"model", input_key, output_key, "tools", "stream"}
        if set(request) - allowed:
            raise VerificationError("unsupported billing, hosted tool, session or request option")
        if request.get("model") != self.model:
            raise VerificationError("unapproved model")
        if request.get("tools", []) != [] or request.get("stream", False) is not False:
            raise VerificationError("executable tools or streaming forbidden")
        maximum = request.get(output_key)
        if type(maximum) is not int or not 0 < maximum <= self.output_ceiling:
            raise VerificationError("inclusive output bound required")
        body = request.get(input_key)
        if isinstance(body, str) and self.protocol == "responses-text/1":
            return
        if not isinstance(body, list) or not body:
            raise VerificationError("text messages required")
        for message in body:
            if (not isinstance(message, dict) or set(message) != {"role", "content"}
                    or message["role"] not in {"user", "assistant", "system", "developer"}
                    or not isinstance(message["content"], str)):
                raise VerificationError("only literal text context allowed")

    def text(self, raw: bytes) -> str:
        response = json_object(raw)
        if self.protocol == "anthropic-text/1":
            parts = response.get("content")
        else:
            output = response.get("output")
            if not isinstance(output, list) or len(output) != 1 or not isinstance(output[0], dict):
                raise VerificationError("incomplete provider output")
            if output[0].get("type") != "message":
                raise VerificationError("provider attempted tool output")
            parts = output[0].get("content")
        if not isinstance(parts, list) or not parts:
            raise VerificationError("missing provider text")
        text: list[str] = []
        for part in parts:
            if not isinstance(part, dict) or part.get("type") not in {"text", "output_text"} or not isinstance(part.get("text"), str):
                raise VerificationError("provider attempted tool output")
            text.append(part["text"])
        if response.get("status", "completed") != "completed" or response.get("stop_reason", "end_turn") != "end_turn":
            raise VerificationError("provider completion ambiguous")
        return "".join(text)

    def usage(self, raw: bytes) -> tuple[ResourceQuantity, ...]:
        usage = json_object(raw).get("usage", {})
        if not isinstance(usage, dict):
            return ()
        result = [ResourceQuantity(Resource.MODEL_CALLS, 1)]
        for field, resource in (("input_tokens", Resource.INPUT_TOKENS), ("output_tokens", Resource.OUTPUT_TOKENS)):
            value = usage.get(field)
            if type(value) is int and value >= 0:
                result.append(ResourceQuantity(resource, value))
        # Exact fixed-price text contract. Cache writes/tiers/betas are rejected;
        # hidden reasoning must be included in output_tokens by the bound contract.
        values = {q.resource: q.quantity for q in result}
        if Resource.INPUT_TOKENS in values and Resource.OUTPUT_TOKENS in values:
            result.append(ResourceQuantity(Resource.USD_NANODOLLARS,
                values[Resource.INPUT_TOKENS] * self.input_nanodollars +
                values[Resource.OUTPUT_TOKENS] * self.output_nanodollars + self.request_nanodollars))
        return tuple(result)


class Upstream(Protocol):
    def generate(self, request: bytes, operation_key: str) -> bytes: ...
    def lookup(self, operation_key: str) -> bytes | None: ...


class HTTPProvider:
    """Fixed endpoint, no redirects, retries, ambient proxies or credential helpers.

    lookup is absent unless supplied with verified provider evidence. A local
    transcript/session ID is never passed as a provider deduplication key.
    """
    def __init__(self, contract: ProviderContract, credential: str,
                 lookup: Callable[[str], bytes | None] | None = None) -> None:
        self.contract, self._credential, self._lookup = contract, credential, lookup
        route = urlsplit(contract.endpoint)
        if route.username or route.password or route.fragment or route.query:
            raise ValueError("fixed provider endpoint required")
        if route.scheme != "https" and not (route.scheme == "http" and route.hostname in {"127.0.0.1", "::1"}):
            raise ValueError("TLS required except local fixture upstream")
        if lookup is not None and not contract.verified_lookup:
            raise ValueError("provider lookup requires a verified recovery contract")

    def generate(self, request: bytes, operation_key: str) -> bytes:
        route = urlsplit(self.contract.endpoint)
        connection_type = http.client.HTTPSConnection if route.scheme == "https" else http.client.HTTPConnection
        connection = connection_type(route.hostname or "", route.port, timeout=10)
        headers = {"Content-Type": "application/json"}
        if self.contract.protocol == "anthropic-text/1":
            headers.update({"x-api-key": self._credential, "anthropic-version": "2023-06-01"})
        else:
            headers["Authorization"] = "Bearer " + self._credential
        if self.contract.verified_lookup and self.contract.recovery_key_header is not None:
            headers[self.contract.recovery_key_header] = operation_key
        try:
            connection.request("POST", route.path, request, headers)
            response = connection.getresponse()
            data = response.read(self.contract.max_response_bytes + 1)
            if len(data) > self.contract.max_response_bytes or response.status != 200:
                raise VerificationError("provider outcome incomplete or HTTP failure; no retry")
            return data
        finally:
            connection.close()

    def lookup(self, operation_key: str) -> bytes | None:
        return self._lookup(operation_key) if self._lookup is not None else None
