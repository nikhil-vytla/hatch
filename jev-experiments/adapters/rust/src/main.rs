use jev_schemars_lab::{decode, Answers};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use std::io::{self, Read};

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
enum Area {
    Billing,
    Technical,
    Account,
    Other,
}
#[derive(Debug, Serialize, Deserialize, JsonSchema)]
struct Ticket {
    /// Which support area applies?
    area: Area,
    /// Is a refund requested?
    refund: bool,
    /// Is essential context missing?
    #[schemars(range(min = 0, max = 1))]
    missing_context: f64,
}
fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut input = String::new();
    io::stdin().read_to_string(&mut input)?;
    let wire: serde_json::Value = serde_json::from_str(&input)?;
    let answers: Answers = serde_json::from_value(wire.get("answers").unwrap_or(&wire).clone())?;
    let result = decode::<Ticket>(&schemars::schema_for!(Ticket).to_value(), answers)
        .map_err(io::Error::other)?;
    println!("{}", serde_json::to_string_pretty(&result)?);
    Ok(())
}
