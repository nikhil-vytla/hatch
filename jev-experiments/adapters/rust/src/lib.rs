//! Original bounded semantic adapter inspired by aaazzam/jev.
use schemars::JsonSchema;
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use serde_json::{json, Map, Value};
use std::collections::BTreeMap;

pub type LabResult<T> = Result<T, String>;
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Answer {
    #[serde(rename = "type")]
    pub kind: String,
    pub value: Value,
    pub probabilities: Option<BTreeMap<String, f64>>,
    pub confidence: Option<f64>,
}
pub type Answers = BTreeMap<String, Answer>;
#[derive(Debug, Serialize)]
pub struct Decision<T> {
    pub value: T,
    pub answers: Answers,
    pub questions: Map<String, Value>,
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
        let description = schema["description"]
            .as_str()
            .filter(|s| !s.trim().is_empty())
            .ok_or_else(|| format!("Missing semantic description: {path}"))?;
        let question = if kind == "string" {
            let options = schema["enum"]
                .as_array()
                .filter(|a| (2..=255).contains(&a.len()))
                .ok_or("Only finite string enums are supported")?;
            let mut criteria = Map::new();
            for option in options {
                let value = option.as_str().ok_or("Enum option must be a string")?;
                criteria.insert(value.into(), Value::String(value.replace('_', " ")));
            }
            json!({"type":"choice", "instructions":description, "criteria":criteria})
        } else if kind == "boolean"
            || kind == "number"
                && schema["minimum"].as_f64() == Some(0.0)
                && schema["maximum"].as_f64() == Some(1.0)
        {
            json!({"type":"noul", "instructions":description})
        } else if kind == "number" && schema["x-jev-levels"].is_array() {
            let levels = schema["x-jev-levels"].as_array().unwrap();
            if !(2..=255).contains(&levels.len())
                || !levels.iter().all(Value::is_string)
                || schema["minimum"].as_f64() != Some(0.0)
                || schema["maximum"].as_f64() != Some((levels.len() - 1) as f64)
            {
                return Err("Invalid explicit score rubric".into());
            }
            json!({"type":"score", "instructions":description, "criteria":levels})
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
                    vec![]
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
        }
        if answer
            .confidence
            .is_some_and(|v| !v.is_finite() || !(0.0..=1.0).contains(&v))
        {
            return Err("Invalid confidence".into());
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
            },
        )]);
        assert!(decode::<Value>(&schema, answers).is_err());
    }
}
