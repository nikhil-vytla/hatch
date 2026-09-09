"""Load a complete revision into the existing bounded step sandbox."""
import base64
from dataclasses import replace
import json
from pathlib import Path
from typing import Mapping

from ..codec import content_ref
from ..contracts.commands import AuthorizedView, RecordedResult, StepOutput
from ..contracts.primitives import ArtifactRef
from ..errors import VerificationError
from ..runtime.sandbox import CandidateSandbox, ConfinementProfile
from .bundles import BundleManager


class BundleSandbox:
    def __init__(self, bundles: BundleManager, backend: CandidateSandbox) -> None:
        self.bundles, self.backend = bundles, backend

    @property
    def wall_limit_milliseconds(self) -> int:
        return self.backend.wall_limit_milliseconds

    def profile(self) -> ConfinementProfile:
        profile = self.backend.profile()
        return replace(profile, name="bundle-step/1:" + profile.name,
                       runtime=content_ref(Path(__file__).read_bytes()))

    def run(self, source: bytes, view: AuthorizedView, private_state: bytes,
            result: RecordedResult | None, inputs: Mapping[ArtifactRef, bytes]) -> StepOutput:
        ref = content_ref(source)
        if self.bundles.state is None or self.bundles.state().active_bundle != ref:
            raise VerificationError("sandbox bundle is not active")
        bundle = self.bundles.load(ref)
        files = {name: self.bundles.objects.read(self.bundles.file(version).content) for name, version in bundle.files}
        # Files and pinned pure dependencies are injected as literal data. Their
        # code only executes inside the same resource/permission boundary.
        file_data = json.dumps({name: base64.b64encode(data).decode("ascii") for name, data in files.items()})
        dependency_data = json.dumps({d.name: self.bundles.objects.read(d.source).decode("utf-8") for d in bundle.dependencies})
        actor = json.dumps(files["actor/step.js"].decode("utf-8"))
        controller = json.dumps(files["controller/step.js"].decode("utf-8"))
        wrapper = f'''
const files = Object.freeze({file_data});
const dependencies = Object.freeze({dependency_data});
const actor = new Function('"use strict";\\n' + {actor} + '\\nreturn step;')();
const controller = new Function('"use strict";\\n' + {controller} + '\\nreturn step;')();
function step(view, state, result, handles) {{
    return controller(view, state, result, handles,
        (v, s, r, h) => actor(v, s, r, h, files, dependencies), files, dependencies);
}}
'''
        return self.backend.run(wrapper.encode(), view, private_state, result, inputs)
