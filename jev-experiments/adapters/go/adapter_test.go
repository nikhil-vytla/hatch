package adapter

import (
	"github.com/invopop/jsonschema"
	"math"
	"testing"
)

type Ticket struct {
	Area           string  `json:"area" jsonschema:"enum=billing,enum=technical,enum=account,enum=other,description=Which support area applies?" validate:"oneof=billing technical account other"`
	Refund         bool    `json:"refund" jsonschema:"description=Is a refund requested?"`
	MissingContext float64 `json:"missing_context" jsonschema:"minimum=0,maximum=1,description=Is essential context missing?" validate:"gte=0,lte=1"`
}

func fixture() map[string]Answer {
	return map[string]Answer{"area": {Type: "choice", Value: "billing", Probabilities: map[string]float64{"billing": .9, "technical": .03, "account": .03, "other": .04}}, "refund": {Type: "noul", Value: .9}, "missing_context": {Type: "noul", Value: .2}}
}
func TestTypedEvidence(t *testing.T) {
	r, e := Decode[Ticket](jsonschema.Reflect(&Ticket{}), fixture())
	if e != nil || !r.Value.Refund || r.Value.Area != "billing" || r.Answers["area"].Probabilities["billing"] != .9 {
		t.Fatalf("%+v %v", r, e)
	}
}
func TestRejectsMalformedAnswers(t *testing.T) {
	for _, v := range []float64{2, math.NaN(), math.Inf(1)} {
		a := fixture()
		a["refund"] = Answer{Type: "noul", Value: v}
		if _, e := Decode[Ticket](jsonschema.Reflect(&Ticket{}), a); e == nil {
			t.Fatal("accepted invalid answer")
		}
	}
	a := fixture()
	a["area"] = Answer{Type: "choice", Value: "billing", Probabilities: map[string]float64{"billing": 1}}
	if _, e := Decode[Ticket](jsonschema.Reflect(&Ticket{}), a); e == nil {
		t.Fatal("accepted malformed probabilities")
	}
}
func TestRejectsFreeText(t *testing.T) {
	type Bad struct {
		Text string `json:"text" jsonschema:"description=Extract text"`
	}
	if _, e := Compile(jsonschema.Reflect(&Bad{})); e == nil {
		t.Fatal("accepted free text")
	}
}
func TestReferences(t *testing.T) {
	type Inner struct {
		Flag bool `json:"flag" jsonschema:"description=True?"`
	}
	type Outer struct {
		Inner Inner `json:"inner"`
	}
	q, e := Compile(jsonschema.Reflect(&Outer{}))
	if e != nil || q["inner.flag"].Type != "noul" {
		t.Fatalf("%v %v", q, e)
	}
}
