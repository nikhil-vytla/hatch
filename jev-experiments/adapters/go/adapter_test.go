package adapter

import (
	"encoding/json"
	"math"
	"reflect"
	"strings"
	"testing"

	"github.com/invopop/jsonschema"
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

func nativeSchema(t *testing.T, field string) *jsonschema.Schema {
	t.Helper()
	var schema jsonschema.Schema
	if err := json.Unmarshal([]byte(`{"type":"object","required":["value"],"properties":{"value":`+field+`}}`), &schema); err != nil {
		t.Fatal(err)
	}
	// invopop's reflected-schema API carries custom annotations in Extras.
	var raw map[string]any
	if err := json.Unmarshal([]byte(field), &raw); err != nil {
		t.Fatal(err)
	}
	property, _ := schema.Properties.Get("value")
	property.Extras = map[string]any{}
	for key, value := range raw {
		if strings.HasPrefix(key, "x-jev-") {
			property.Extras[key] = value
		}
	}
	return &schema
}

func TestNativeAnnotationShapesAndScorePrecedence(t *testing.T) {
	schema := nativeSchema(t, `{"type":"number","minimum":0,"maximum":1,"x-jev-instructions":null,"x-jev-levels":[{"meaning":"routine"},["severe",null]]}`)
	questions, err := Compile(schema)
	if err != nil || questions["value"].Type != "score" || questions["value"].Instructions != nil {
		t.Fatalf("%+v %v", questions, err)
	}
	levels := questions["value"].Criteria.([]any)
	if !reflect.DeepEqual(levels, []any{object{"meaning": "routine"}, []any{"severe", nil}}) {
		t.Fatalf("lost rubric: %+v", levels)
	}
	for _, field := range []string{
		`{"type":"boolean","x-jev-instructions":{"question":["Check",null]},"x-jev-criteria":{"true":{"has":"evidence"},"false":null}}`,
		`{"type":"string","enum":["a","b"],"x-jev-instructions":[],"x-jev-criteria":{"a":{"subtree":[true,2]},"b":null}}`,
	} {
		if _, err := Compile(nativeSchema(t, field)); err != nil {
			t.Fatal(err)
		}
	}
}

func TestRejectsUnknownOrMisplacedNativeAnnotations(t *testing.T) {
	for _, field := range []string{
		`{"type":"boolean","description":"Check","x-jev-levels":["no","yes"]}`,
		`{"type":"boolean","description":"Check","x-jev-critera":{"true":"yes","false":"no"}}`,
		`{"type":"boolean","description":"Check","x-jev-criteria":null}`,
		`{"type":"boolean","x-jev-instructions":3}`,
		`{"type":"string","description":"Choose","enum":["a","b"],"x-jev-criteria":{"a":"A","different":"B"}}`,
		`{"type":"number","description":"Rate","minimum":0,"maximum":10,"x-jev-levels":["0","1","2","3","4","5","6","7","8","9","10"]}`,
		`{"type":"number","description":"Rate","minimum":0,"maximum":1,"x-jev-levels":["low","high"],"x-jev-criteria":{"true":"yes","false":"no"}}`,
	} {
		if _, err := Compile(nativeSchema(t, field)); err == nil {
			t.Fatalf("accepted %s", field)
		}
	}
}

func TestNoulDistributionAndMetadataSurviveDecode(t *testing.T) {
	raw := []byte(`{"area":{"type":"choice","value":"billing","probabilities":{"billing":0.9,"technical":0.03,"account":0.03,"other":0.04},"confidence":0.8,"confidenceDefinition":"provider-distribution-confidence"},"refund":{"type":"noul","value":0.9,"probabilities":{"false":0.1,"true":0.9},"probabilityTrue":0.9,"confidence":null},"missing_context":{"type":"noul","value":0.2,"probabilities":{"false":0.8,"true":0.2},"probabilityTrue":0.2,"confidence":null}}`)
	var answers map[string]Answer
	if err := json.Unmarshal(raw, &answers); err != nil {
		t.Fatal(err)
	}
	result, err := Decode[Ticket](jsonschema.Reflect(&Ticket{}), answers)
	if err != nil || !result.Value.Refund {
		t.Fatalf("%+v %v", result, err)
	}
	encoded, err := json.Marshal(result.Answers)
	if err != nil {
		t.Fatal(err)
	}
	var before, after any
	json.Unmarshal(raw, &before)
	json.Unmarshal(encoded, &after)
	if !reflect.DeepEqual(before, after) {
		t.Fatalf("metadata changed: %s", encoded)
	}
	bad := answers["refund"]
	bad.Probabilities["true"], bad.Probabilities["false"] = .1, .9
	answers["refund"] = bad
	if _, err := Decode[Ticket](jsonschema.Reflect(&Ticket{}), answers); err == nil {
		t.Fatal("accepted inconsistent Noul distribution")
	}
}

func TestScoreLegendAndContinuousValueSurviveDecode(t *testing.T) {
	type Result struct {
		Value float64 `json:"value"`
	}
	schema := nativeSchema(t, `{"type":"number","minimum":0,"maximum":1,"x-jev-instructions":null,"x-jev-levels":[{"meaning":"routine"},["severe",null]]}`)
	var answers map[string]Answer
	if err := json.Unmarshal([]byte(`{"value":{"type":"score","value":0.35,"probabilities":{"0":0.65,"1":0.35},"confidence":0.4,"argmax":0,"legend":{"0":{"meaning":"routine"},"1":["severe",null]}}}`), &answers); err != nil {
		t.Fatal(err)
	}
	result, err := Decode[Result](schema, answers)
	if err != nil || result.Value.Value != .35 || *result.Answers["value"].Argmax != 0 {
		t.Fatalf("%+v %v", result, err)
	}
	answers["value"].Legend["0"] = "different rubric"
	if _, err := Decode[Result](schema, answers); err == nil {
		t.Fatal("accepted changed legend")
	}
}

func TestUnrecognizedAnswerMetadataCannotDisappear(t *testing.T) {
	var answer Answer
	if err := json.Unmarshal([]byte(`{"type":"noul","value":0.5,"unrecognizedMeaning":"lost"}`), &answer); err == nil {
		t.Fatal("ignored unknown answer field")
	}
	answers := fixture()
	area := answers["area"]
	area.Probabilities = nil
	answers["area"] = area
	if _, err := Decode[Ticket](jsonschema.Reflect(&Ticket{}), answers); err == nil {
		t.Fatal("accepted missing Choice distribution")
	}
}

func TestNativeLegendsPreserveRequestedDescriptions(t *testing.T) {
	type Result struct {
		Value any `json:"value"`
	}
	for _, tc := range []struct {
		name, field, answer, first string
	}{
		{"choice", `{"type":"string","enum":["a","b"],"description":"Choose","x-jev-criteria":{"a":{"boundary":[true,2,null]},"b":null}}`, `{"type":"choice","value":"a","probabilities":{"a":0.6,"b":0.4},"legend":{"a":{"boundary":[true,2,null]},"b":null}}`, "a"},
		{"noul", `{"type":"boolean","description":"Check","x-jev-criteria":{"true":{"boundary":[true,2,null]},"false":null}}`, `{"type":"noul","value":0.6,"probabilities":{"true":0.6,"false":0.4},"legend":{"true":{"boundary":[true,2,null]},"false":null}}`, "true"},
		{"score", `{"type":"number","minimum":0,"maximum":1,"description":"Rate","x-jev-levels":[{"boundary":[true,2,null]},null]}`, `{"type":"score","value":0.4,"probabilities":{"0":0.6,"1":0.4},"legend":{"0":{"boundary":[true,2,null]},"1":null}}`, "0"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			schema := nativeSchema(t, tc.field)
			fresh := func() map[string]Answer {
				var a Answer
				if err := json.Unmarshal([]byte(tc.answer), &a); err != nil {
					t.Fatal(err)
				}
				return map[string]Answer{"value": a}
			}
			answers := fresh()
			result, err := Decode[Result](schema, answers)
			if err != nil {
				t.Fatal(err)
			}
			if !reflect.DeepEqual(result.Answers, answers) {
				t.Fatal("decode changed a valid legend")
			}
			for _, mutation := range []string{"description", "missing", "extra", "scalar"} {
				t.Run(mutation, func(t *testing.T) {
					bad := fresh()
					legend := bad["value"].Legend
					switch mutation {
					case "description":
						legend[tc.first] = object{"boundary": []any{float64(1), float64(2), nil}}
					case "missing":
						delete(legend, tc.first)
					case "extra":
						legend["extra"] = nil
					case "scalar":
						legend[tc.first] = true
					}
					if _, err := Decode[Result](schema, bad); err == nil {
						t.Fatal("accepted a changed or incomplete legend")
					}
				})
			}
		})
	}
}

func TestPlainNoulLegendUsesNativeBoundaryEntries(t *testing.T) {
	type Result struct {
		Value bool `json:"value"`
	}
	schema := nativeSchema(t, `{"type":"boolean","description":"Check"}`)
	for _, legend := range []object{
		{"true": object{"evidence": []any{true, float64(2)}}, "false": nil},
		{"true": "Criterion met", "false": []any{"Criterion absent"}},
	} {
		answers := map[string]Answer{"value": {Type: "noul", Value: .6, Legend: legend}}
		result, err := Decode[Result](schema, answers)
		if err != nil || !result.Value.Value || !reflect.DeepEqual(result.Answers, answers) {
			t.Fatalf("plain Noul legend was rejected or changed: %v", err)
		}
	}
	for _, legend := range []object{
		{"true": "Yes"},
		{"true": "Yes", "false": "No", "extra": nil},
		{"true": "Yes", "other": nil},
		{"true": true, "false": nil},
		{"true": "Yes", "false": float64(0)},
	} {
		if _, err := Decode[Result](schema, map[string]Answer{"value": {Type: "noul", Value: .6, Legend: legend}}); err == nil {
			t.Fatal("plain Noul accepted invalid boundary entries")
		}
	}
}

func TestDefaultChoiceLegendUsesGeneratedDescriptions(t *testing.T) {
	type Result struct {
		Value string `json:"value"`
	}
	schema := nativeSchema(t, `{"type":"string","enum":["not_ready","ready"],"description":"Choose"}`)
	answers := map[string]Answer{"value": {Type: "choice", Value: "ready", Probabilities: map[string]float64{"not_ready": .2, "ready": .8}, Legend: object{"not_ready": "not ready", "ready": "ready"}}}
	if _, err := Decode[Result](schema, answers); err != nil {
		t.Fatal(err)
	}
	answers["value"].Legend["not_ready"] = "different"
	if _, err := Decode[Result](schema, answers); err == nil {
		t.Fatal("default Choice accepted changed descriptions")
	}
}
