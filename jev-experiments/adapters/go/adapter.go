package adapter

import (
	"bytes"
	"encoding/json"
	"fmt"
	"math"
	"reflect"
	"strings"

	"github.com/go-playground/validator/v10"
	"github.com/invopop/jsonschema"
)

type Question struct {
	Type         string `json:"type"`
	Instructions any    `json:"instructions"`
	Criteria     any    `json:"criteria,omitempty"`
}
type Answer struct {
	Type                 string             `json:"type"`
	Value                any                `json:"value"`
	Probabilities        map[string]float64 `json:"probabilities"`
	Confidence           *float64           `json:"confidence"`
	Legend               map[string]any     `json:"legend,omitempty"`
	Argmax               *int               `json:"argmax,omitempty"`
	ProbabilityTrue      *float64           `json:"probabilityTrue,omitempty"`
	ConfidenceDefinition string             `json:"confidenceDefinition,omitempty"`
	NativeValue          any                `json:"nativeValue,omitempty"`
	ProbabilityMass      *float64           `json:"probabilityMass,omitempty"`
}

func (a *Answer) UnmarshalJSON(data []byte) error {
	type wire Answer
	var decoded wire
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&decoded); err != nil {
		return err
	}
	*a = Answer(decoded)
	return nil
}

func entry(value any) bool {
	switch value.(type) {
	case nil, string, object, []any:
		_, err := json.Marshal(value)
		return err == nil
	default:
		return false
	}
}

type Decision[T any] struct {
	Value     T                   `json:"value"`
	Answers   map[string]Answer   `json:"answers"`
	Questions map[string]Question `json:"questions"`
}
type Transport func(state any, questions map[string]Question) (map[string]Answer, error)
type object = map[string]any

func rootMap(schema *jsonschema.Schema) (object, error) {
	b, err := json.Marshal(schema)
	if err != nil {
		return nil, err
	}
	var root object
	err = json.Unmarshal(b, &root)
	return root, err
}
func resolve(raw, root object, depth int) (object, error) {
	if depth > 12 {
		return nil, fmt.Errorf("recursive schema or nesting exceeds 12 levels")
	}
	ref, ok := raw["$ref"].(string)
	if !ok {
		return raw, nil
	}
	if !strings.HasPrefix(ref, "#/") {
		return nil, fmt.Errorf("only local references are supported")
	}
	var node any = root
	for _, part := range strings.Split(ref[2:], "/") {
		o, ok := node.(object)
		if !ok {
			return nil, fmt.Errorf("unresolved reference")
		}
		node = o[strings.ReplaceAll(strings.ReplaceAll(part, "~1", "/"), "~0", "~")]
	}
	target, ok := node.(object)
	if !ok {
		return nil, fmt.Errorf("unresolved reference")
	}
	target, err := resolve(target, root, depth+1)
	if err != nil {
		return nil, err
	}
	merged := object{}
	for k, v := range target {
		merged[k] = v
	}
	for k, v := range raw {
		if k != "$ref" {
			merged[k] = v
		}
	}
	return merged, nil
}
func compileMap(root object) (map[string]Question, error) {
	out := map[string]Question{}
	var walk func(object, string, int) error
	walk = func(raw object, path string, depth int) error {
		if depth > 12 {
			return fmt.Errorf("schema nesting exceeds 12 levels")
		}
		schema, err := resolve(raw, root, 0)
		if err != nil {
			return err
		}
		kind, _ := schema["type"].(string)
		for key := range schema {
			if strings.HasPrefix(key, "x-jev-") {
				if kind == "object" || key != "x-jev-instructions" && key != "x-jev-criteria" && key != "x-jev-levels" {
					return fmt.Errorf("unknown or misplaced Jev annotation: %s", key)
				}
			}
		}
		if kind == "object" {
			properties, ok := schema["properties"].(object)
			if !ok || len(properties) == 0 {
				return fmt.Errorf("empty object")
			}
			required, _ := schema["required"].([]any)
			for name, value := range properties {
				if name == "" || strings.Contains(name, ".") || name == "__proto__" || name == "constructor" || name == "prototype" {
					return fmt.Errorf("unsafe field name")
				}
				found := false
				for _, r := range required {
					if r == name {
						found = true
					}
				}
				if !found {
					return fmt.Errorf("optional fields are unsupported: %s", name)
				}
				field, ok := value.(object)
				if !ok {
					return fmt.Errorf("invalid field schema")
				}
				next := name
				if path != "" {
					next = path + "." + name
				}
				if err = walk(field, next, depth+1); err != nil {
					return err
				}
			}
			return nil
		}
		instructions, explicit := schema["x-jev-instructions"]
		description, _ := schema["description"].(string)
		if !explicit {
			instructions = description
		}
		if (!explicit && strings.TrimSpace(description) == "") || path == "" || !entry(instructions) {
			return fmt.Errorf("semantic description required: %s", path)
		}
		q := Question{Instructions: instructions}
		_, hasLevels := schema["x-jev-levels"]
		criteriaValue, hasCriteria := schema["x-jev-criteria"]
		if hasLevels && (kind != "number" || hasCriteria) {
			return fmt.Errorf("misplaced score rubric")
		}
		if kind == "string" {
			options, ok := schema["enum"].([]any)
			if !ok || len(options) < 2 || len(options) > 255 {
				return fmt.Errorf("only finite string enums are supported")
			}
			criteria := object{}
			for _, option := range options {
				value, ok := option.(string)
				_, duplicate := criteria[value]
				if !ok || strings.TrimSpace(value) == "" || duplicate {
					return fmt.Errorf("enum option must be string")
				}
				criteria[value] = strings.ReplaceAll(value, "_", " ")
			}
			if hasCriteria {
				native, ok := criteriaValue.(object)
				if !ok || len(native) != len(criteria) {
					return fmt.Errorf("criteria must match enum")
				}
				for key := range criteria {
					value, exists := native[key]
					if !exists || !entry(value) {
						return fmt.Errorf("criteria must match enum with native entries")
					}
				}
				criteria = native
			}
			q.Type = "choice"
			q.Criteria = criteria
		} else if kind == "boolean" || kind == "number" && !hasLevels && schema["minimum"] == float64(0) && schema["maximum"] == float64(1) {
			q.Type = "noul"
			if hasCriteria {
				criteria, ok := criteriaValue.(object)
				if !ok || len(criteria) != 2 {
					return fmt.Errorf("Noul needs true and false criteria")
				}
				for _, key := range []string{"true", "false"} {
					value, exists := criteria[key]
					if !exists || !entry(value) {
						return fmt.Errorf("Noul needs true and false native entries")
					}
				}
				q.Criteria = criteria
			}
		} else if levels, ok := schema["x-jev-levels"].([]any); kind == "number" && ok {
			if len(levels) < 2 || len(levels) > 10 || schema["minimum"] != float64(0) || schema["maximum"] != float64(len(levels)-1) {
				return fmt.Errorf("invalid explicit score rubric")
			}
			for _, x := range levels {
				if !entry(x) {
					return fmt.Errorf("score levels must be native entries")
				}
			}
			q.Type = "score"
			q.Criteria = levels
		} else {
			return fmt.Errorf("unsupported semantic type: %s", path)
		}
		out[path] = q
		return nil
	}
	return out, walk(root, "", 0)
}
func Compile(schema *jsonschema.Schema) (map[string]Question, error) {
	root, err := rootMap(schema)
	if err != nil {
		return nil, err
	}
	return compileMap(root)
}
func Decode[T any](schema *jsonschema.Schema, answers map[string]Answer) (Decision[T], error) {
	var result Decision[T]
	root, err := rootMap(schema)
	if err != nil {
		return result, err
	}
	questions, err := compileMap(root)
	if err != nil {
		return result, err
	}
	if len(answers) != len(questions) {
		return result, fmt.Errorf("answer IDs must match questions")
	}
	for id, q := range questions {
		a, ok := answers[id]
		if !ok || a.Type != q.Type {
			return result, fmt.Errorf("missing or wrong answer type: %s", id)
		}
		expected := map[string]bool{}
		if q.Type == "choice" {
			options := q.Criteria.(object)
			v, ok := a.Value.(string)
			if _, exists := options[v]; !ok || !exists {
				return result, fmt.Errorf("unknown choice")
			}
			for k := range options {
				expected[k] = true
			}
		} else {
			upper := 1.0
			if q.Type == "score" {
				upper = float64(len(q.Criteria.([]any)) - 1)
				for i := 0; i <= int(upper); i++ {
					expected[fmt.Sprint(i)] = true
				}
			} else {
				expected["false"], expected["true"] = true, true
			}
			v, ok := a.Value.(float64)
			if !ok || math.IsNaN(v) || math.IsInf(v, 0) || v < 0 || v > upper {
				return result, fmt.Errorf("out of range value")
			}
		}
		if a.Probabilities != nil {
			sum := 0.0
			if len(a.Probabilities) != len(expected) {
				return result, fmt.Errorf("malformed distribution")
			}
			for k, v := range a.Probabilities {
				if !expected[k] || math.IsNaN(v) || math.IsInf(v, 0) || v < 0 || v > 1 {
					return result, fmt.Errorf("malformed distribution")
				}
				sum += v
			}
			if math.Abs(sum-1) > .025 {
				return result, fmt.Errorf("malformed distribution")
			}
			if q.Type == "noul" && (math.Abs(a.Probabilities["true"]-a.Value.(float64)) > 1e-6 || math.Abs(a.Probabilities["false"]-(1-a.Value.(float64))) > 1e-6) {
				return result, fmt.Errorf("Noul distribution disagrees with scalar")
			}
		} else if q.Type != "noul" {
			return result, fmt.Errorf("complete choice/score distribution required")
		}
		if a.Confidence != nil && (math.IsNaN(*a.Confidence) || math.IsInf(*a.Confidence, 0) || *a.Confidence < 0 || *a.Confidence > 1) {
			return result, fmt.Errorf("invalid confidence")
		}
		if a.ProbabilityTrue != nil && (q.Type != "noul" || math.IsNaN(*a.ProbabilityTrue) || math.Abs(*a.ProbabilityTrue-a.Value.(float64)) > 1e-6) {
			return result, fmt.Errorf("invalid probabilityTrue")
		}
		if a.Argmax != nil {
			if q.Type != "score" || *a.Argmax < 0 || *a.Argmax >= len(expected) {
				return result, fmt.Errorf("invalid score argmax")
			}
			for _, p := range a.Probabilities {
				if p > a.Probabilities[fmt.Sprint(*a.Argmax)] {
					return result, fmt.Errorf("argmax is not a modal level")
				}
			}
		}
		if a.Legend != nil {
			if q.Type != "score" || len(a.Legend) != len(expected) {
				return result, fmt.Errorf("invalid score legend")
			}
			for i, level := range q.Criteria.([]any) {
				if actual, ok := a.Legend[fmt.Sprint(i)]; !ok || !reflect.DeepEqual(actual, level) {
					return result, fmt.Errorf("score legend changed requested rubric")
				}
			}
		}
	}
	var decode func(object, string) (any, error)
	decode = func(raw object, path string) (any, error) {
		s, err := resolve(raw, root, 0)
		if err != nil {
			return nil, err
		}
		if s["type"] == "object" {
			value := object{}
			for k, v := range s["properties"].(object) {
				next := k
				if path != "" {
					next = path + "." + k
				}
				value[k], err = decode(v.(object), next)
				if err != nil {
					return nil, err
				}
			}
			return value, nil
		}
		a := answers[path]
		if s["type"] == "boolean" {
			return a.Value.(float64) >= .5, nil
		}
		return a.Value, nil
	}
	value, err := decode(root, "")
	if err != nil {
		return result, err
	}
	wire, err := json.Marshal(value)
	if err != nil {
		return result, err
	}
	if err = json.Unmarshal(wire, &result.Value); err != nil {
		return result, err
	}
	if err = validator.New(validator.WithRequiredStructEnabled()).Struct(result.Value); err != nil {
		return result, err
	}
	result.Answers = answers
	result.Questions = questions
	return result, nil
}
func Decide[T any](state any, transport Transport) (Decision[T], error) {
	var sample T
	schema := jsonschema.Reflect(&sample)
	questions, err := Compile(schema)
	if err != nil {
		return Decision[T]{}, err
	}
	answers, err := transport(state, questions)
	if err != nil {
		return Decision[T]{}, err
	}
	return Decode[T](schema, answers)
}
