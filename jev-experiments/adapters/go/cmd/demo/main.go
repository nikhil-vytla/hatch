package main

import (
	"encoding/json"
	"fmt"
	"github.com/invopop/jsonschema"
	"io"
	"jev-lab/adapter"
	"os"
)

type Ticket struct {
	Area           string  `json:"area" jsonschema:"enum=billing,enum=technical,enum=account,enum=other,description=Which support area applies?" validate:"oneof=billing technical account other"`
	Refund         bool    `json:"refund" jsonschema:"description=Is a refund requested?"`
	MissingContext float64 `json:"missing_context" jsonschema:"minimum=0,maximum=1,description=Is essential context missing?" validate:"gte=0,lte=1"`
}

func main() {
	wire, e := io.ReadAll(os.Stdin)
	if e != nil {
		panic(e)
	}
	var input struct {
		Answers map[string]adapter.Answer `json:"answers"`
	}
	if e = json.Unmarshal(wire, &input); e != nil {
		panic(e)
	}
	result, e := adapter.Decode[Ticket](jsonschema.Reflect(&Ticket{}), input.Answers)
	if e != nil {
		panic(e)
	}
	output, e := json.MarshalIndent(result, "", "  ")
	if e != nil {
		panic(e)
	}
	fmt.Println(string(output))
}
