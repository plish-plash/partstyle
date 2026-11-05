# Part record format

A part record is a local cache of a datasheet: one YAML file, `<id>.yaml`, for one electrical part
in one package. Once it exists, nobody should need the datasheet again. **Capture everything a
designer could need, and never leave information out because it has no field**: add a section with
a name of your own. Only `id`, `summary` and `pins` are required, and nothing else is ever refused.

Write records from a datasheet, or from memory only for parts you know exist. Never extrapolate an
MPN from a series.

## Example

```yaml
id: LM386N-1
summary: 0.3 W low-voltage audio power amplifier, gain 20-200, 4-12 V, DIP-8
manufacturer: Texas Instruments
preferred_mpn: LM386N-1/NOPB
package: DIP-8
footprint: Package_DIP:DIP-8_W7.62mm
pins:
  1: { name: GAIN1, unused: open, note: "open with pin 8 open gives gain 20" }
  2: { name: -INPUT, type: input, vmax: 0.4V, unused: required }
  3: { name: +INPUT, type: input, vmax: 0.4V, unused: required }
  4: { name: GND, type: power_in }
  5: { name: VOUT, type: output }
  6: { name: VS, type: power_in, vmax: 15V }
  7: { name: BYPASS, unused: open, note: "a capacitor here improves supply rejection" }
  8: { name: GAIN8, unused: open }
ratings:
  vs: { min: 4V, max: 12V, abs_max: 15V }
  gain: { min: 20, max: 200 }
  iq_typ: 4mA
  rin_typ: 50k
  bandwidth_typ: 300kHz
temp_c: [0, 70]
requirements:
  - text: Bypass VS close to the pin
    cap: { from: VS, to: GND, min: 100n }
  - Bias both inputs to ground; they are referenced to it internally
notes:
  - Output sits at VS/2, so a speaker needs a coupling capacitor.
sourcing: { lifecycle: active, digikey: LM386N-1/NOPB-ND }
provenance:
  datasheet: https://www.ti.com/lit/gpn/lm386
  extracted_by: ai
  verified_by: null

# Anything else is a section of your own, in whatever shape suits it.
output_power:
  - { vs: 6V, load: 8, thd: 10%, power_typ: 325mW }
application_circuits:
  gain_20: Pins 1 and 8 open; 250 uF to the speaker; 10 ohm + 50 nF Zobel on the output.
  gain_200: As gain 20, plus 10 uF between pins 1 and 8.
thermal: { theta_ja: 107C/W }
```

## Fields

| Field           | Meaning                                                                            |
| --------------- | ---------------------------------------------------------------------------------- |
| `id`            | The name used in designs (`lib:ID`) and the file name: letters, digits, `. _ + -`  |
| `summary`       | One line: what it is, key ratings, package                                         |
| `pins`          | By pad number (below)                                                              |
| `preferred_mpn` | The orderable part to buy, with its ordering and packaging codes                   |
| `manufacturer`  | Leave it out for a part made by many                                               |
| `package`       | `SOIC-8`, `0603`, ...                                                              |
| `footprint`     | KiCad `Library:Footprint`                                                          |
| `kicad_symbol`  | KiCad `Library:Symbol`, when finding it by name would not (below)                  |
| `ratings`       | Limits and key figures: any YAML, nested or not. `query` reads them (`vs.max`)     |
| `temp_c`        | `[min, max]`, the operating range of this grade; checked against the project       |
| `requirements`  | What the datasheet asks of the circuit: text, or a check (below)                   |
| `notes`         | Gotchas a designer would otherwise miss                                            |
| `generic`       | For a concrete passive: the generic it satisfies, `cap(100n, 50V, X7R, 10%, 0603)` |
| `sourcing`      | `lcsc`, `digikey`, `mouser`: distributor part numbers; `lifecycle`                 |
| `provenance`    | `datasheet` (a URL), `extracted_by` (`ai`), `verified_by: null`                    |

Leave `verified_by: null`: only a person verifies a record.

**Identity.** A record is the electrical part, not an order code. Its `id` is the part's name
without ordering suffixes (reel, RoHS, packing), which belong in `preferred_mpn`. A part in another
package is another record, since pads and footprint differ; give the id a package suffix when you
add the second (`MCP6002-DIP8`). A different temperature grade is another record only if you need
both.

**Pins.** Every pad, keyed by number (`1`, `A7`, `EP`), with the datasheet's name (`~` for active
low: `~RESET`). A shared name (`GND` on several pads) is fine.

- `type`: `input`, `output`, `bidir`, `tristate`, `passive`, `power_in`, `power_out`,
  `open_collector`, `open_emitter` or `nc`. Leave it out for `passive`.
- `vmax`: absolute maximum relative to ground, for supply and input pins (`6V`). It is checked
  against the net's voltage. A limit that depends on another pin (`VCC + 0.3V`) is kept for
  reading but can't be checked.
- `unused`: what the datasheet says about leaving the pin unconnected. `open` is fine (an optional
  gain pin); `required` must be connected (`~RESET`, `EN`, `BOOT0`). By default an unconnected
  `bidir`, output-type or `nc` pin says nothing, `input`, `passive` and `power_out` pins warn, and
  `power_in` is an error whatever this says.
- `note`: anything else about the pin.

**Requirement checks.** A requirement is text, or `text` plus one check the engine verifies. `from`
and `to` are pin names or numbers of this part, or net names; a left-out `to` means ground. A check
it can't read stays as text, with a warning.

- `cap: { from: VCC, to: GND, min: 100n }`, with `each: true` for one per pin of that name
- `res: { from: SDA, to: VCC, min: 1k, max: 10k }`
- `tie: { from: EN, to: VIN }`: the pin must be on the same net

**Footprints.** Use KiCad's standard libraries. Pads should match the pin table: a difference is
reported as a warning for the person to review, and the record is still written. Mounting pads
named `MP` are PCB detail, so leave them out of `pins`.

**Symbols.** KiCad symbols are found by id and MPN. A part KiCad doesn't name needs `kicad_symbol`,
or it is drawn as a box. Generic symbols work for any pinout, as pins pair up by name, so name your
pins the same way:

| Part        | `kicad_symbol`                                                    | Pin names     |
| ----------- | ----------------------------------------------------------------- | ------------- |
| NPN, PNP    | `Device:Q_NPN`, `Device:Q_PNP`                                    | `B C E`       |
| N, P MOSFET | `Device:Q_NMOS`, `Device:Q_PMOS`                                  | `D G S`       |
| Diode       | `Device:D`, `Device:D_Schottky`, `Device:D_TVS`, `Device:D_Zener` | `K A`         |
| Connector   | `Connector_Generic:Conn_01x03`                                    | numbers match |
