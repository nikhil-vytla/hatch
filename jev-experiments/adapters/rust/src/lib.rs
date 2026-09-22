//! Original bounded semantic adapter inspired by aaazzam/jev.
use schemars::JsonSchema;
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use serde_json::{json, Map, Value};
use std::collections::BTreeMap;

pub type LabResult<T> = Result<T, String>;
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Answer {
    #[serde(rename = "type")]
    pub kind: String,
    pub value: Value,
    pub probabilities: Option<BTreeMap<String, f64>>,
    pub confidence: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub legend: Option<BTreeMap<String, Value>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub argmax: Option<usize>,
    #[serde(
        rename = "probabilityTrue",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub probability_true: Option<f64>,
    #[serde(
        rename = "confidenceDefinition",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub confidence_definition: Option<String>,
    #[serde(
        rename = "nativeValue",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub native_value: Option<Value>,
    #[serde(
        rename = "probabilityMass",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub probability_mass: Option<f64>,
}
pub type Answers = BTreeMap<String, Answer>;
#[derive(Debug, Serialize)]
pub struct Decision<T> {
    pub value: T,
    pub answers: Answers,
    pub questions: Map<String, Value>,
}

fn entry(value: &Value) -> bool {
    matches!(
        value,
        Value::Null | Value::String(_) | Value::Object(_) | Value::Array(_)
    )
}

fn resolve(schema: &Value, root: &Value, depth: usize) -> LabResult<Value> {
    if depth > 12 {
        return Err("Recursive schema or nesting exceeds 12 levels".into());
    }
    if let Some(reference) = schema.get("$ref").and_then(Value::as_str) {
        let pointer = reference
            .strip_prefix('#')
            .ok_or("External references are unsupported")?;
        if !pointer.starts_with('/') {
            return Err("Only local definition references are supported".into());
        }
        let mut target = resolve(
            root.pointer(pointer).ok_or("Unresolved reference")?,
            root,
            depth + 1,
        )?;
        let object = target
            .as_object_mut()
            .ok_or("Reference does not name a schema object")?;
        for (key, value) in schema.as_object().ok_or("Expected schema object")? {
            if key != "$ref" {
                object.insert(key.clone(), value.clone());
            }
        }
        Ok(target)
    } else {
        Ok(schema.clone())
    }
}

pub fn compile(root: &Value) -> LabResult<Map<String, Value>> {
    fn walk(
        raw: &Value,
        root: &Value,
        path: &str,
        depth: usize,
        out: &mut Map<String, Value>,
    ) -> LabResult<()> {
        if depth > 12 {
            return Err("Schema nesting exceeds 12 levels".into());
        }
        let schema = resolve(raw, root, 0)?;
        let kind = schema["type"].as_str().unwrap_or("");
        for key in schema.as_object().ok_or("Expected schema object")?.keys() {
            if key.starts_with("x-jev-")
                && (kind == "object"
                    || !["x-jev-instructions", "x-jev-criteria", "x-jev-levels"]
                        .contains(&key.as_str()))
            {
                return Err(format!("Unknown or misplaced Jev annotation: {key}"));
            }
        }
        if kind == "object" {
            let properties = schema["properties"].as_object().ok_or("Empty object")?;
            if properties.is_empty() {
                return Err("Empty objects are unsupported".into());
            }
            let required = schema["required"]
                .as_array()
                .ok_or("All fields must be required")?;
            for (name, value) in properties {
                if name.is_empty()
                    || name.contains('.')
                    || ["__proto__", "constructor", "prototype"].contains(&name.as_str())
                {
                    return Err("Unsafe field name".into());
                }
                if !required.contains(&Value::String(name.clone())) {
                    return Err(format!("Optional field: {name}"));
                }
                let next = if path.is_empty() {
                    name.clone()
                } else {
                    format!("{path}.{name}")
                };
                walk(value, root, &next, depth + 1, out)?;
            }
            return Ok(());
        }
        let instructions = match schema.get("x-jev-instructions") {
            Some(value) if entry(value) => value.clone(),
            Some(_) => return Err("Instructions must be a native entry".into()),
            None => Value::String(
                schema["description"]
                    .as_str()
                    .filter(|s| !s.trim().is_empty())
                    .ok_or_else(|| format!("Missing semantic description: {path}"))?
                    .into(),
            ),
        };
        let has_levels = schema.get("x-jev-levels").is_some();
        let native_criteria = schema.get("x-jev-criteria");
        if has_levels && (kind != "number" || native_criteria.is_some()) {
            return Err("Misplaced score rubric".into());
        }
        let question = if kind == "string" {
            let options = schema["enum"]
                .as_array()
                .filter(|a| (2..=255).contains(&a.len()))
                .ok_or("Only finite string enums are supported")?;
            let mut criteria = Map::new();
            for option in options {
                let value = option.as_str().ok_or("Enum option must be a string")?;
                if value.trim().is_empty() || criteria.contains_key(value) {
                    return Err("Enum options must be nonempty and unique".into());
                }
                criteria.insert(value.into(), Value::String(value.replace('_', " ")));
            }
            if let Some(native) = native_criteria {
                let native = native
                    .as_object()
                    .ok_or("Choice criteria must be named entries")?;
                if native.len() != criteria.len()
                    || criteria
                        .keys()
                        .any(|key| !native.get(key).is_some_and(entry))
                {
                    return Err("Criteria must match the enum with native entries".into());
                }
                criteria = native.clone();
            }
            json!({"type":"choice", "instructions":instructions, "criteria":criteria})
        } else if kind == "boolean"
            || kind == "number"
                && !has_levels
                && schema["minimum"].as_f64() == Some(0.0)
                && schema["maximum"].as_f64() == Some(1.0)
        {
            let mut question = json!({"type":"noul", "instructions":instructions});
            if let Some(native) = native_criteria {
                let criteria = native
                    .as_object()
                    .ok_or("Noul needs true and false entries")?;
                if criteria.len() != 2
                    || !["true", "false"]
                        .iter()
                        .all(|key| criteria.get(*key).is_some_and(entry))
                {
                    return Err("Noul needs true and false native entries".into());
                }
                question["criteria"] = native.clone();
            }
            question
        } else if kind == "number" && schema["x-jev-levels"].is_array() {
            let levels = schema["x-jev-levels"].as_array().unwrap();
            if !(2..=10).contains(&levels.len())
                || !levels.iter().all(entry)
                || schema["minimum"].as_f64() != Some(0.0)
                || schema["maximum"].as_f64() != Some((levels.len() - 1) as f64)
            {
                return Err("Invalid explicit score rubric".into());
            }
            json!({"type":"score", "instructions":instructions, "criteria":levels})
        } else {
            return Err(format!("Unsupported semantic type: {path}"));
        };
        if path.is_empty() {
            return Err("Root must be an object".into());
        }
        out.insert(path.into(), question);
        Ok(())
    }
    let mut questions = Map::new();
    walk(root, root, "", 0, &mut questions)?;
    Ok(questions)
}

pub fn decode<T: DeserializeOwned>(schema: &Value, answers: Answers) -> LabResult<Decision<T>> {
    let questions = compile(schema)?;
    if answers.len() != questions.len() {
        return Err("Answer IDs must match questions".into());
    }
    for (id, question) in &questions {
        let answer = answers
            .get(id)
            .ok_or_else(|| format!("Missing answer: {id}"))?;
        if question["type"].as_str() != Some(&answer.kind) {
            return Err(format!("Wrong answer type: {id}"));
        }
        let expected: Vec<String> = match answer.kind.as_str() {
            "choice" => {
                let criteria = question["criteria"].as_object().unwrap();
                if !answer
                    .value
                    .as_str()
                    .is_some_and(|v| criteria.contains_key(v))
                {
                    return Err("Unknown choice".into());
                }
                criteria.keys().cloned().collect()
            }
            _ => {
                let upper = if answer.kind == "noul" {
                    1.0
                } else {
                    (question["criteria"].as_array().unwrap().len() - 1) as f64
                };
                if !answer
                    .value
                    .as_f64()
                    .is_some_and(|v| v.is_finite() && v >= 0.0 && v <= upper)
                {
                    return Err("Out-of-range value".into());
                }
                if answer.kind == "score" {
                    (0..=upper as usize).map(|i| i.to_string()).collect()
                } else {
                    vec!["false".into(), "true".into()]
                }
            }
        };
        if let Some(probs) = &answer.probabilities {
            if probs.len() != expected.len()
                || probs.iter().any(|(k, v)| {
                    !expected.contains(k) || !v.is_finite() || !(0.0..=1.0).contains(v)
                })
                || (probs.values().sum::<f64>() - 1.0).abs() > 0.025
            {
                return Err("Malformed distribution".into());
            }
            if answer.kind == "noul"
                && ((probs["true"] - answer.value.as_f64().unwrap()).abs() > 1e-6
                    || (probs["false"] - (1.0 - answer.value.as_f64().unwrap())).abs() > 1e-6)
            {
                return Err("Noul distribution disagrees with scalar".into());
            }
        } else if answer.kind != "noul" {
            return Err("Complete Choice/Score distribution required".into());
        }
        if answer
            .confidence
            .is_some_and(|v| !v.is_finite() || !(0.0..=1.0).contains(&v))
        {
            return Err("Invalid confidence".into());
        }
        if let Some(probability) = answer.probability_true {
            if answer.kind != "noul"
                || !probability.is_finite()
                || (probability - answer.value.as_f64().unwrap()).abs() > 1e-6
            {
                return Err("Invalid probabilityTrue".into());
            }
        }
        if let Some(argmax) = answer.argmax {
            if answer.kind != "score" || argmax >= expected.len() {
                return Err("Invalid Score argmax".into());
            }
            let probabilities = answer.probabilities.as_ref().unwrap();
            if probabilities
                .values()
                .any(|p| *p > probabilities[&argmax.to_string()])
            {
                return Err("Argmax is not a modal level".into());
            }
        }
        if let Some(legend) = &answer.legend {
            if answer.kind != "score"
                || legend.len() != expected.len()
                || question["criteria"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .enumerate()
                    .any(|(i, level)| legend.get(&i.to_string()) != Some(level))
            {
                return Err("Score legend changed the requested rubric".into());
            }
        }
    }
    fn value(raw: &Value, root: &Value, path: &str, answers: &Answers) -> LabResult<Value> {
        let schema = resolve(raw, root, 0)?;
        if schema["type"] == "object" {
            let mut result = Map::new();
            for (name, field) in schema["properties"].as_object().unwrap() {
                let next = if path.is_empty() {
                    name.clone()
                } else {
                    format!("{path}.{name}")
                };
                result.insert(name.clone(), value(field, root, &next, answers)?);
            }
            Ok(Value::Object(result))
        } else if schema["type"] == "boolean" {
            Ok(Value::Bool(answers[path].value.as_f64().unwrap() >= 0.5))
        } else {
            Ok(answers[path].value.clone())
        }
    }
    let typed =
        serde_json::from_value(value(schema, schema, "", &answers)?).map_err(|e| e.to_string())?;
    Ok(Decision {
        value: typed,
        answers,
        questions,
    })
}

pub fn decide<
    T: DeserializeOwned + JsonSchema,
    F: FnOnce(&Value, &Map<String, Value>) -> LabResult<Answers>,
>(
    state: &Value,
    transport: F,
) -> LabResult<Decision<T>> {
    let schema = schemars::schema_for!(T).to_value();
    let questions = compile(&schema)?;
    decode(&schema, transport(state, &questions)?)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[derive(Debug, Deserialize, JsonSchema)]
    struct Flag {
        /// Is a refund requested?
        refund: bool,
    }
    fn answer(value: f64) -> Answers {
        BTreeMap::from([(
            "refund".into(),
            Answer {
                kind: "noul".into(),
                value: json!(value),
                probabilities: None,
                confidence: None,
                ..Default::default()
            },
        )])
    }
    #[test]
    fn typed_value_and_evidence() {
        let result = decide::<Flag, _>(&json!("refund please"), |_, _| Ok(answer(0.9))).unwrap();
        assert!(result.value.refund);
        assert_eq!(result.answers["refund"].value, json!(0.9));
    }
    #[test]
    fn refuses_out_of_range() {
        assert!(decode::<Flag>(&schemars::schema_for!(Flag).to_value(), answer(2.0)).is_err());
    }
    #[test]
    fn rejects_free_text_and_optional() {
        assert!(compile(&json!({"type":"object","required":["x"],"properties":{"x":{"type":"string","description":"Extract text"}}})).is_err());
        assert!(compile(
            &json!({"type":"object","properties":{"x":{"type":"boolean","description":"True?"}}})
        )
        .is_err());
    }
    #[test]
    fn local_reference() {
        let schema = json!({"type":"object","required":["flag"],"properties":{"flag":{"$ref":"#/$defs/flag","description":"True?"}},"$defs":{"flag":{"type":"boolean"}}});
        assert_eq!(compile(&schema).unwrap()["flag"]["type"], "noul");
    }
    #[test]
    fn rejects_malformed_distribution() {
        let schema = json!({"type":"object","required":["x"],"properties":{"x":{"type":"string","enum":["a","b"],"description":"Which?"}}});
        let answers = BTreeMap::from([(
            "x".into(),
            Answer {
                kind: "choice".into(),
                value: json!("a"),
                probabilities: Some(BTreeMap::from([("a".into(), 1.0)])),
                confidence: None,
                ..Default::default()
            },
        )]);
        assert!(decode::<Value>(&schema, answers).is_err());
    }

    fn field_schema(field: Value) -> Value {
        json!({"type":"object", "required":["value"], "properties":{"value":field}})
    }

    #[test]
    fn native_annotations_and_two_level_score() {
        let schema = field_schema(
            json!({"type":"number","minimum":0,"maximum":1,"x-jev-instructions":null,"x-jev-levels":[{"when":"routine"},["severe",null]]}),
        );
        let question = &compile(&schema).unwrap()["value"];
        assert_eq!(question["type"], "score");
        assert!(question["instructions"].is_null());
        assert_eq!(
            question["criteria"],
            json!([{"when":"routine"},["severe",null]])
        );
        for field in [
            json!({"type":"boolean","x-jev-instructions":{"question":["Check",null]},"x-jev-criteria":{"true":{"has":"evidence"},"false":null}}),
            json!({"type":"string","enum":["a","b"],"x-jev-instructions":[],"x-jev-criteria":{"a":{"tree":[true,2]},"b":null}}),
        ] {
            assert!(compile(&field_schema(field)).is_ok());
        }
    }

    #[test]
    fn rejects_unknown_or_misplaced_annotations() {
        for field in [
            json!({"type":"boolean","description":"Check","x-jev-levels":["no","yes"]}),
            json!({"type":"boolean","description":"Check","x-jev-critera":{"true":"yes","false":"no"}}),
            json!({"type":"boolean","description":"Check","x-jev-criteria":null}),
            json!({"type":"boolean","x-jev-instructions":3}),
            json!({"type":"string","description":"Choose","enum":["a","b"],"x-jev-criteria":{"a":"A","different":"B"}}),
            json!({"type":"number","description":"Rate","minimum":0,"maximum":10,"x-jev-levels":["0","1","2","3","4","5","6","7","8","9","10"]}),
            json!({"type":"number","description":"Rate","minimum":0,"maximum":1,"x-jev-levels":["low","high"],"x-jev-criteria":{"true":"yes","false":"no"}}),
        ] {
            assert!(compile(&field_schema(field)).is_err());
        }
    }

    #[test]
    fn preserves_noul_distribution_and_metadata() {
        let raw = json!({"refund":{"type":"noul","value":0.9,"probabilities":{"false":0.1,"true":0.9},"confidence":null,"probabilityTrue":0.9}});
        let answers: Answers = serde_json::from_value(raw.clone()).unwrap();
        let result = decode::<Flag>(&schemars::schema_for!(Flag).to_value(), answers).unwrap();
        assert_eq!(serde_json::to_value(result.answers).unwrap(), raw);
        let mut bad = raw;
        bad["refund"]["probabilities"] = json!({"false":0.9,"true":0.1});
        assert!(decode::<Flag>(
            &schemars::schema_for!(Flag).to_value(),
            serde_json::from_value(bad).unwrap()
        )
        .is_err());
    }

    #[test]
    fn preserves_score_value_legend_and_argmax() {
        let schema = field_schema(
            json!({"type":"number","minimum":0,"maximum":1,"x-jev-instructions":null,"x-jev-levels":[{"meaning":"routine"},["severe",null]]}),
        );
        let raw = json!({"value":{"type":"score","value":0.35,"probabilities":{"0":0.65,"1":0.35},"confidence":0.4,"confidenceDefinition":"provider-distribution-confidence","argmax":0,"legend":{"0":{"meaning":"routine"},"1":["severe",null]}}});
        let result =
            decode::<Value>(&schema, serde_json::from_value(raw.clone()).unwrap()).unwrap();
        assert_eq!(result.value["value"], 0.35);
        assert_eq!(serde_json::to_value(result.answers).unwrap(), raw);
        let mut bad = raw;
        bad["value"]["legend"]["0"] = json!("changed");
        assert!(decode::<Value>(&schema, serde_json::from_value(bad).unwrap()).is_err());
    }

    #[test]
    fn unknown_answer_metadata_and_missing_distribution_are_errors() {
        assert!(serde_json::from_value::<Answer>(
            json!({"type":"noul","value":0.5,"lostMeaning":true})
        )
        .is_err());
        let schema = field_schema(json!({"type":"string","enum":["a","b"],"description":"Choose"}));
        let answers = serde_json::from_value(
            json!({"value":{"type":"choice","value":"a","confidence":null}}),
        )
        .unwrap();
        assert!(decode::<Value>(&schema, answers).is_err());
    }
}
