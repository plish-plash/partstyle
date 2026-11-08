import { type Category, Circuit, type TestCase } from "./builder.js";

function make(
  id: string,
  category: Category,
  title: string,
  description: string,
  build: (c: Circuit) => void,
): TestCase {
  const c = new Circuit();
  build(c);
  return { id, category, title, description, input: c.build(id) };
}

const range = (n: number) => Array.from({ length: n }, (_, i) => i);

/** The ATmega328P-AU pin arrangement, shared by the cases built around it. */
function atmega(c: Circuit, ref: string) {
  c.ic(ref, "ATmega328P-AU", {
    left: [
      "PC6/RESET:bidir",
      null,
      "PB6/XTAL1:bidir",
      "PB7/XTAL2:bidir",
      null,
      "AREF:passive",
      "ADC6",
      "ADC7",
    ],
    right: [
      "PB0:bidir",
      "PB1:bidir",
      "PB2:bidir",
      "PB3:bidir",
      "PB4:bidir",
      "PB5:bidir",
      null,
      "PC0:bidir",
      "PC1:bidir",
      "PC2:bidir",
      "PC3:bidir",
      "PC4:bidir",
      "PC5:bidir",
      null,
      "PD0:bidir",
      "PD1:bidir",
      "PD2:bidir",
      "PD3:bidir",
      "PD4:bidir",
      "PD5:bidir",
      "PD6:bidir",
      "PD7:bidir",
    ],
    top: ["VCC", "VCC2", "AVCC"],
    bottom: ["GND", "GND2", "GND3"],
  });
}

export const CASES: TestCase[] = [
  // Sanity
  make(
    "rc-filter",
    "Sanity",
    "RC low-pass filter",
    "The smallest signal chain: one series part and one shunt, input to output.",
    (c) => {
      c.res("R1", "1k").cap("C1", "100n");
      c.input("IN", "R1.1");
      c.output("OUT", "R1.2", "C1.1");
      c.gnd("GND", "C1.2");
    },
  ),
  make(
    "voltage-divider",
    "Sanity",
    "Voltage divider",
    "A rail, two resistors and ground in one vertical line, tapped from the side.",
    (c) => {
      c.res("R1", "10k").res("R2", "4k7");
      c.rail("+5V", "R1.1");
      c.output("VSENSE", "R1.2", "R2.1");
      c.gnd("GND", "R2.2");
    },
  ),
  make(
    "signal-declared-backwards",
    "Sanity",
    "Chain declared output first",
    "Passives only, written from the output back to the input. With no IC to set a direction, only the signal flow rule can put the input on the left.",
    (c) => {
      c.cap("C2", "10n").res("R2", "4k7").cap("C1", "10n").res("R1", "4k7");
      c.output("OUT", "R2.2", "C2.1");
      c.net("MID", "R1.2", "C1.1", "R2.1");
      c.input("IN", "R1.1");
      c.gnd("GND", "C1.2", "C2.2");
    },
  ),
  make(
    "mosfet-switch",
    "Sanity",
    "MOSFET low-side switch",
    "Gate resistor, gate pull-down, a load on the drain, and a flyback diode to the rail.",
    (c) => {
      c.fet("Q1", "AO3400");
      c.res("R1", "100").res("R2", "100k").diode("D1", "1N4148");
      c.conn("J1", "LOAD", ["1:passive", "2:passive"]);
      c.input("DRIVE", "R1.1");
      c.net("GATE", "R1.2", "R2.1", "Q1.G");
      c.net("SW", "Q1.D", "D1.1", "J1.2");
      c.rail("+12V", "D1.2", "J1.1");
      c.gnd("GND", "R2.2", "Q1.S");
    },
  ),

  // MCU
  make(
    "mcu-bench-sensor",
    "MCU",
    "ATmega328P support parts",
    "From Partstyle's bench-sensor example: decoupling, reset pull-up, ISP and UART headers and a status LED around one MCU.",
    (c) => {
      atmega(c, "U4");
      c.cap("C9", "100n").cap("C10", "100n").cap("C11", "100n").cap("C12", "100n");
      c.res("R5", "10k");
      c.conn("J3", "ISP", ["1", "2", "3", "4", "5", "6"]);
      c.conn("J5", "UART", ["1", "2", "3"]);
      c.res("R6", "330").led("D4", "red");
      c.rail("+3V3", "U4.VCC", "U4.VCC2", "U4.AVCC", "C9.1", "C10.1", "C11.1", "R5.1", "J3.2");
      c.gnd(
        "GND",
        "U4.GND",
        "U4.GND2",
        "U4.GND3",
        "C9.2",
        "C10.2",
        "C11.2",
        "C12.2",
        "J3.6",
        "J5.3",
        "D4.2",
      );
      c.net("AREF", "U4.AREF", "C12.1");
      c.input("AIN", "U4.ADC7");
      c.net("RESET", "U4.PC6/RESET", "R5.2", "J3.5");
      c.net("MOSI", "U4.PB3", "J3.4");
      c.net("MISO", "U4.PB4", "J3.1");
      c.net("SCK", "U4.PB5", "J3.3");
      c.net("TXD", "U4.PD1", "J5.1");
      c.net("RXD", "U4.PD0", "J5.2");
      c.net("LED", "U4.PB1", "R6.1");
      c.net("LED_A", "R6.2", "D4.1");
    },
  ),
  make(
    "mcu-crowded-pulldowns",
    "MCU",
    "Pull-downs on neighbouring pins",
    "From Partstyle's pulldowns fixture: three adjacent MCU pins each run to a header and also need a pull-down, with no room to hang them.",
    (c) => {
      atmega(c, "U1");
      c.conn("J1", "BTN", ["1", "2", "3", "4", "5", "6"]);
      c.res("R1", "10k").res("R2", "10k").res("R3", "10k").cap("C1", "100n");
      c.rail("+3V3", "U1.VCC", "U1.VCC2", "U1.AVCC", "C1.1", "J1.2");
      c.gnd("GND", "U1.GND", "U1.GND2", "U1.GND3", "C1.2", "R1.2", "R2.2", "R3.2", "J1.6");
      c.net("BTN0", "U1.PB0", "J1.1", "R1.1");
      c.net("BTN1", "U1.PB1", "J1.3", "R2.1");
      c.net("BTN2", "U1.PB2", "J1.5", "R3.1");
    },
  ),
  make(
    "mcu-full-qfp",
    "MCU",
    "Four-sided MCU, fully populated",
    "An STM32-style QFP surrounded by everything at once: crystal, reset, boot strap, decoupling, USB, SWD, I2C pull-ups, LEDs and a button. Signal pins on all four sides.",
    (c) => {
      c.ic("U1", "STM32F103CB", {
        left: [
          "NRST:input",
          "BOOT0:input",
          null,
          "OSC_IN:input",
          "OSC_OUT:output",
          null,
          "PA0:bidir",
          "PA1:bidir",
          "PA2:bidir",
          "PA3:bidir",
          null,
          "PA9:bidir",
          "PA10:bidir",
        ],
        right: [
          "PA11:bidir",
          "PA12:bidir",
          null,
          "SWDIO:bidir",
          "SWCLK:bidir",
          null,
          "PB6:bidir",
          "PB7:bidir",
          null,
          "PB12:bidir",
          "PB13:bidir",
          "PB14:bidir",
        ],
        top: ["VBAT", "VDD1", "VDD2", "VDD3", "VDDA", "PC13:bidir"],
        bottom: ["VSS1", "VSS2", "VSS3", "VSSA", "PB2:bidir"],
        topPitch: 3,
      });
      c.cap("C1", "100n").cap("C2", "100n").cap("C3", "100n").cap("C4", "1u").cap("C5", "10u");
      c.xtal("Y1", "8MHz").cap("C6", "20p").cap("C7", "20p");
      c.res("R1", "10k").cap("C8", "100n");
      c.res("R2", "10k");
      c.res("R3", "22").res("R4", "22").res("R5", "1k5");
      c.conn("J1", "USB", ["VBUS:power_in", "D-", "D+", "GND:power_in"]);
      c.conn("J2", "SWD", ["VCC:power_in", "SWDIO", "SWCLK", "GND:power_in"]);
      c.res("R6", "4k7").res("R7", "4k7");
      c.conn("J3", "I2C", ["SCL", "SDA"]);
      c.res("R8", "330").led("D1", "green");
      c.res("R9", "330").led("D2", "red");
      c.res("R10", "330").led("D3", "blue");
      c.res("R11", "10k");
      c.conn("J4", "UART", ["TX", "RX"]);
      c.conn("J5", "ADC", ["A0", "A1", "A2", "A3"]);
      c.rail(
        "+3V3",
        "U1.VBAT",
        "U1.VDD1",
        "U1.VDD2",
        "U1.VDD3",
        "U1.VDDA",
        "C1.1",
        "C2.1",
        "C3.1",
        "C4.1",
        "C5.1",
        "R1.1",
        "R5.1",
        "R6.1",
        "R7.1",
        "J2.VCC",
        "R11.1",
      );
      c.rail("+5V", "J1.VBUS");
      c.gnd(
        "GND",
        "U1.VSS1",
        "U1.VSS2",
        "U1.VSS3",
        "U1.VSSA",
        "C1.2",
        "C2.2",
        "C3.2",
        "C4.2",
        "C5.2",
        "C6.2",
        "C7.2",
        "C8.2",
        "R2.2",
        "J1.GND",
        "J2.GND",
        "D1.2",
        "D2.2",
        "D3.2",
      );
      c.net("NRST", "U1.NRST", "R1.2", "C8.1");
      c.net("BOOT0", "U1.BOOT0", "R2.1");
      c.net("OSC_IN", "U1.OSC_IN", "Y1.1", "C6.1");
      c.net("OSC_OUT", "U1.OSC_OUT", "Y1.2", "C7.1");
      c.net("USB_DM", "U1.PA11", "R3.1");
      c.net("USB_DP", "U1.PA12", "R4.1");
      c.net("DM", "R3.2", "J1.D-");
      c.net("DP", "R4.2", "J1.D+", "R5.2");
      c.net("SWDIO", "U1.SWDIO", "J2.SWDIO");
      c.net("SWCLK", "U1.SWCLK", "J2.SWCLK");
      c.net("SCL", "U1.PB6", "R6.2", "J3.SCL");
      c.net("SDA", "U1.PB7", "R7.2", "J3.SDA");
      c.net("LED0", "U1.PB12", "R8.1");
      c.net("LED0_A", "R8.2", "D1.1");
      c.net("LED1", "U1.PB13", "R9.1");
      c.net("LED1_A", "R9.2", "D2.1");
      c.net("LED2", "U1.PB14", "R10.1");
      c.net("LED2_A", "R10.2", "D3.1");
      c.net("TX", "U1.PA9", "J4.TX");
      c.net("RX", "U1.PA10", "J4.RX");
      c.net("A0", "U1.PA0", "J5.A0");
      c.net("A1", "U1.PA1", "J5.A1");
      c.net("A2", "U1.PA2", "J5.A2");
      c.net("A3", "U1.PA3", "J5.A3");
      c.net("TAMPER", "U1.PC13", "R11.2");
      c.input("WAKE", "U1.PB2");
    },
  ),

  // LED chains
  make(
    "led-sink-8",
    "LED chains",
    "8 LEDs sinking into a driver",
    "Rail to LED to resistor to a constant-sink output, eight times, from one side of the IC.",
    (c) => {
      c.ic("U1", "TPIC6B595", {
        left: ["SER_IN", "SRCK", "RCK", "~OE", "~SRCLR", null, "SER_OUT:output"],
        right: range(8).map((i) => `DRAIN${i}:open_collector`),
        top: ["VCC"],
        bottom: ["GND"],
      });
      c.cap("C1", "100n");
      for (const i of range(8)) {
        c.res(`R${i + 1}`, "220");
        c.led(`D${i + 1}`, "red");
      }
      c.input("DATA", "U1.SER_IN");
      c.input("SCK", "U1.SRCK");
      c.input("LATCH", "U1.RCK");
      c.input("OE", "U1.~OE");
      c.input("CLR", "U1.~SRCLR");
      c.output("DOUT", "U1.SER_OUT");
      for (const i of range(8)) {
        c.net(`OUT${i}`, `U1.DRAIN${i}`, `R${i + 1}.1`);
        c.net(`A${i}`, `R${i + 1}.2`, `D${i + 1}.2`);
      }
      c.rail("+5V", "U1.VCC", "C1.1", ...range(8).map((i) => `D${i + 1}.1`));
      c.gnd("GND", "U1.GND", "C1.2");
    },
  ),
  make(
    "led-source-mcu",
    "LED chains",
    "8 LEDs sourced from a port",
    "Port pin to resistor to LED to ground, eight times on adjacent pins.",
    (c) => {
      c.ic("U1", "MCU", {
        left: ["RESET", "SCL:bidir", "SDA:bidir"],
        right: range(8).map((i) => `P${i}`),
        top: ["VDD"],
        bottom: ["VSS"],
      });
      for (const i of range(8)) {
        c.res(`R${i + 1}`, "330");
        c.led(`D${i + 1}`, "green");
      }
      c.input("NRST", "U1.RESET");
      c.input("I2C_SCL", "U1.SCL");
      c.input("I2C_SDA", "U1.SDA");
      for (const i of range(8)) {
        c.net(`P${i}`, `U1.P${i}`, `R${i + 1}.1`);
        c.net(`A${i}`, `R${i + 1}.2`, `D${i + 1}.1`);
      }
      c.rail("+3V3", "U1.VDD");
      c.gnd("GND", "U1.VSS", ...range(8).map((i) => `D${i + 1}.2`));
    },
  ),
  make(
    "led-driver-16",
    "LED chains",
    "16-channel constant-current driver",
    "A TLC5916-style part with outputs on both sides. Each channel is one LED to the rail; each side has a set resistor and decoupling.",
    (c) => {
      c.ic("U1", "TLC5926", {
        left: range(8).map((i) => `OUT${i}:open_collector`),
        right: range(8).map((i) => `OUT${i + 8}:open_collector`),
        top: ["VDD", "SDI:input", "CLK:input", "LE:input"],
        bottom: ["GND", "R-EXT:passive", "OE:input", "SDO:output"],
      });
      c.cap("C1", "100n").cap("C2", "10u").res("R17", "620");
      for (const i of range(16)) c.led(`D${i + 1}`, "white");
      for (const i of range(16)) c.net(`CH${i}`, `U1.OUT${i}`, `D${i + 1}.2`);
      c.input("SIN", "U1.SDI");
      c.input("SCLK", "U1.CLK");
      c.input("LATCH", "U1.LE");
      c.input("BLANK", "U1.OE");
      c.output("SOUT", "U1.SDO");
      c.net("IREF", "U1.R-EXT", "R17.1");
      c.rail("+5V", "U1.VDD", "C1.1", "C2.1", ...range(16).map((i) => `D${i + 1}.1`));
      c.gnd("GND", "U1.GND", "C1.2", "C2.2", "R17.2");
    },
  ),
  make(
    "led-rgb-3",
    "LED chains",
    "3 RGB LEDs on a driver",
    "Three common-anode RGB LEDs, each with three series resistors from one driver. The resistors should line up in three neat groups.",
    (c) => {
      c.ic("U1", "PCA9685", {
        left: ["SCL", "SDA:bidir", "~OE", null, "A0", "A1"],
        right: range(9).map((i) => `LED${i}:open_collector`),
        top: ["VDD"],
        bottom: ["GND"],
      });
      for (const i of range(3)) {
        c.ic(
          `D${i + 1}`,
          "RGB",
          { left: ["R:passive", "G:passive", "B:passive"], top: ["A:passive"] },
          "ic",
        );
      }
      for (const i of range(9)) c.res(`R${i + 1}`, "150");
      c.input("I2C_SCL", "U1.SCL");
      c.input("I2C_SDA", "U1.SDA");
      c.input("OE", "U1.~OE");
      for (const i of range(9)) {
        const led = Math.floor(i / 3) + 1;
        const color = ["R", "G", "B"][i % 3];
        c.net(`LED${i}`, `U1.LED${i}`, `R${i + 1}.1`);
        c.net(`K${i}`, `R${i + 1}.2`, `D${led}.${color}`);
      }
      c.rail("+5V", "U1.VDD", "D1.A", "D2.A", "D3.A");
      c.gnd("GND", "U1.GND", "U1.A0", "U1.A1");
    },
  ),

  // Signal chains
  make(
    "signal-sensor-afe",
    "Signal chains",
    "Sensor front end",
    "From Partstyle's bench-sensor example: connector, ESD clamp, RC filter, pull-down, unity-gain buffer and output RC.",
    (c) => {
      c.conn("J2", "SENSOR", ["1", "2", "3"]);
      c.diode("D3", "PESD5V0");
      c.res("R2", "1k").res("R4", "100k").cap("C6", "10n");
      c.opamp("U3", "MCP6002");
      c.cap("C8", "100n").res("R3", "1k").cap("C7", "100n");
      c.net("SENSE_RAW", "J2.1", "D3.2", "R2.1");
      c.net("SENSE", "R2.2", "R4.1", "C6.1", "U3.+");
      c.net("BUF", "U3.OUT", "U3.-", "R3.1");
      c.output("AIN", "R3.2", "C7.1");
      c.rail("+5V", "J2.2");
      c.rail("+3V3", "U3.V+", "C8.1");
      c.gnd("GND", "J2.3", "D3.1", "R4.2", "C6.2", "C7.2", "C8.2", "U3.V-");
    },
  ),
  make(
    "signal-audio-chain",
    "Signal chains",
    "Long chain with many shunts",
    "Line input to an output through protection, filtering, gain and a tone stage: thirteen parts in a row with shunts on most nets.",
    (c) => {
      c.res("R1", "1k").diode("D1", "BAT54").diode("D2", "BAT54").cap("C1", "1u");
      c.res("R2", "100k").res("R3", "2k2").cap("C2", "470p").res("R4", "10k").cap("C3", "1n");
      c.opamp("U1", "NE5532");
      c.res("R5", "10k").res("R6", "1k").cap("C4", "100n").cap("C5", "47u").res("R7", "4k7");
      c.cap("C6", "10n").res("R8", "100").cap("C7", "100p").cap("C8", "100n").cap("C9", "100n");
      c.input("LINE_IN", "R1.1");
      c.net("CLAMP", "R1.2", "D1.1", "D2.2", "C1.1");
      c.net("AC", "C1.2", "R2.1", "R3.1");
      c.net("LP1", "R3.2", "C2.1", "R4.1");
      c.net("LP2", "R4.2", "C3.1", "U1.+");
      c.net("FB", "U1.-", "R5.1", "R6.1");
      c.net("AMP", "U1.OUT", "R5.2", "C4.1");
      c.net("HP", "R6.2", "C5.1");
      c.net("TONE", "C4.2", "R7.1", "C6.1");
      c.output("LINE_OUT", "R7.2", "R8.1", "C7.1");
      c.rail("+15V", "D1.2", "U1.V+", "C8.1");
      c.rail("-15V", "D2.1", "U1.V-", "C9.2");
      c.gnd("GND", "R2.2", "C2.2", "C3.2", "C5.2", "C6.2", "C7.2", "R8.2", "C8.2", "C9.1");
    },
  ),
  make(
    "signal-lc-ladder",
    "Signal chains",
    "LC ladder filter",
    "Seven elements alternating series inductors and shunt capacitors, with no IC to anchor them.",
    (c) => {
      c.ind("L1", "100n").ind("L2", "220n").ind("L3", "220n").ind("L4", "100n");
      c.cap("C1", "22p").cap("C2", "47p").cap("C3", "47p").cap("C4", "22p");
      c.input("RF_IN", "L1.1", "C1.1");
      c.net("N1", "L1.2", "C2.1", "L2.1");
      c.net("N2", "L2.2", "C3.1", "L3.1");
      c.net("N3", "L3.2", "C4.1", "L4.1");
      c.output("RF_OUT", "L4.2");
      c.gnd("GND", "C1.2", "C2.2", "C3.2", "C4.2");
    },
  ),
  make(
    "signal-opamp-cascade",
    "Signal chains",
    "Op-amp cascade with feedback",
    "Two inverting stages and a follower. The feedback parts loop around each op-amp and must stay out of the signal path.",
    (c) => {
      c.opamp("U1", "TL072").opamp("U2", "TL072").opamp("U3", "TL072");
      c.res("R1", "10k").res("R2", "100k").cap("C1", "22p");
      c.res("R3", "10k").res("R4", "47k").cap("C2", "22p");
      c.res("R5", "1k").cap("C3", "100n");
      c.res("R6", "10k").res("R7", "10k");
      c.input("IN", "R1.1");
      c.net("SUM1", "R1.2", "R2.1", "C1.1", "U1.-");
      c.net("OUT1", "U1.OUT", "R2.2", "C1.2", "R3.1");
      c.net("SUM2", "R3.2", "R4.1", "C2.1", "U2.-");
      c.net("OUT2", "U2.OUT", "R4.2", "C2.2", "R5.1");
      c.net("LP", "R5.2", "C3.1", "U3.+");
      c.output("OUT", "U3.OUT", "U3.-");
      c.net("VREF", "R6.2", "R7.1", "U1.+", "U2.+");
      c.rail("+12V", "U1.V+", "U2.V+", "U3.V+", "R6.1");
      c.gnd("GND", "U1.V-", "U2.V-", "U3.V-", "C3.2", "R7.2");
    },
  ),

  // Power
  make(
    "power-rails",
    "Power",
    "Two cascaded regulators",
    "From Partstyle's bench-sensor example: barrel jack, reverse-polarity diode, 5 V and 3.3 V regulators, their caps, and a power LED. Current flows left to right along the rails.",
    (c) => {
      c.conn("J1", "12V", ["TIP:power_out", "SLEEVE:power_in", "SWITCH:power_in"]);
      c.diode("D1", "1N5819");
      c.ic("U1", "L7805", { left: ["IN:power_in"], right: ["OUT:power_out"], bottom: ["GND"] });
      c.cap("C1", "330n").cap("C2", "100n").cap("C3", "10u");
      c.ic("U2", "MCP1700", { left: ["VIN:power_in"], right: ["VOUT:power_out"], bottom: ["GND"] });
      c.cap("C4", "1u").cap("C5", "1u").res("R1", "1k").led("D2", "green");
      c.net("VIN_RAW", "J1.TIP", "D1.1");
      c.rail("+12V", "D1.2", "U1.IN", "C1.1");
      c.rail("+5V", "U1.OUT", "C2.1", "C3.1", "U2.VIN", "C4.1", "R1.1");
      c.rail("+3V3", "U2.VOUT", "C5.1");
      c.net("PWR_LED", "R1.2", "D2.1");
      c.gnd(
        "GND",
        "J1.SLEEVE",
        "J1.SWITCH",
        "U1.GND",
        "C1.2",
        "C2.2",
        "C3.2",
        "U2.GND",
        "C4.2",
        "C5.2",
        "D2.2",
      );
    },
  ),
  make(
    "power-buck",
    "Power",
    "Buck converter",
    "Switch node, inductor, catch diode, output caps and a feedback divider running back to the IC.",
    (c) => {
      c.ic("U1", "LM2596", {
        left: ["VIN:power_in", "EN:input"],
        right: ["SW:output", "BOOT:passive", null, "FB:input"],
        bottom: ["GND"],
      });
      c.cap("C1", "100u").cap("C2", "100n").cap("C3", "10n");
      c.ind("L1", "33u").diode("D1", "SS34");
      c.cap("C4", "220u").cap("C5", "100n");
      c.res("R1", "10k").res("R2", "3k3").res("R3", "100k");
      c.rail("+12V", "U1.VIN", "C1.1", "C2.1", "R3.1");
      c.net("ENABLE", "U1.EN", "R3.2");
      c.net("SW", "U1.SW", "C3.1", "D1.2", "L1.1");
      c.net("BST", "U1.BOOT", "C3.2");
      c.rail("+5V", "L1.2", "C4.1", "C5.1", "R1.1");
      c.net("VFB", "U1.FB", "R1.2", "R2.1");
      c.gnd("GND", "U1.GND", "C1.2", "C2.2", "D1.1", "C4.2", "C5.2", "R2.2");
    },
  ),

  // Whole sheets
  make(
    "sheet-top-level",
    "Whole sheets",
    "Top-level sheet of child blocks",
    "From the brightness-tester project: four child sheets and nothing else. Power ports get no sheet pins, so PWR has no pins at all, and an 8-wire bus runs from MCU to DSP.",
    (c) => {
      const segments = ["A", "B", "C", "D", "E", "F", "G", "DP"].map((s) => `SEG_${s}`);
      c.sheet("PWR", "power", [], []);
      c.sheet("MCU", "mcu", ["LDR_IN"], segments);
      c.sheet("SNS", "sensor", [], ["LDR_OUT"]);
      c.sheet("DSP", "display", segments, []);
      c.net("LDR_OUT", "SNS.LDR_OUT", "MCU.LDR_IN");
      for (const s of segments) c.net(s, `MCU.${s}`, `DSP.${s}`);
    },
  ),
  make(
    "sheet-triangle-synth",
    "Whole sheets",
    "Triangle/square synth on one sheet",
    "From the triangle-synth project: a quad op amp (four units and a power unit) as integrator, Schmitt trigger, buffer and VREF, two pots, and two jacks. The square output's divider sits far from its jack, which once took a wire right across the sheet.",
    (c) => {
      const amp = (ref: string) =>
        c.ic(ref, "TL074", { left: ["+:input", null, "-:input"], right: [null, "OUT"] }, "opamp");
      const pot = (ref: string, value: string) =>
        c.ic(ref, value, {
          top: ["CCW:passive"],
          right: ["WIPER:passive"],
          bottom: ["CW:passive"],
        });
      c.conn("J1", "12V", ["PIN:power_out", "SLEEVE:power_in", "SWITCH:power_in"]);
      c.diode("D1", "schottky").cap("C1", "100n").cap("C2", "22u");
      c.res("R1", "10k").res("R2", "10k").cap("C3", "10u");
      amp("U1A");
      amp("U1B");
      amp("U1C");
      amp("U1D");
      c.ic("U1E", "TL074", { top: ["V+"], bottom: ["V-"] });
      pot("RV1", "100k");
      c.res("R3", "3.3k").cap("C5", "330n").res("R4", "10k").res("R5", "47k").res("R6", "4.7k");
      pot("RV2", "10k");
      c.cap("C6", "10u").res("R7", "470").res("R8", "100k");
      c.conn("J2", "SJ1-3523N", ["T", "R", "S"]);
      c.cap("C7", "10u").res("R9", "22k").res("R10", "3.3k");
      c.conn("J3", "SJ1-3523N", ["T", "R", "S"]);
      c.net("+12V_IN", "J1.PIN", "D1.1");
      c.rail("+12V", "D1.2", "U1E.V+", "C1.1", "C2.1", "R1.1");
      c.gnd(
        "GND",
        "J1.SLEEVE",
        "J1.SWITCH",
        "U1E.V-",
        "C1.2",
        "C2.2",
        "R2.2",
        "C3.2",
        "R8.2",
        "J2.S",
        "R10.2",
        "J3.S",
      );
      c.net("VREF_DIV", "R1.2", "R2.1", "C3.1", "U1D.+");
      c.net("VREF", "U1D.OUT", "U1D.-", "U1A.+", "U1B.-", "RV2.CCW");
      c.net("SQUARE", "U1B.OUT", "R5.2", "RV1.CW", "C7.1");
      c.net("PITCH", "RV1.WIPER", "RV1.CCW", "R3.1");
      c.net("INT_IN", "R3.2", "U1A.-", "C5.1");
      c.net("TRI", "U1A.OUT", "C5.2", "R4.1", "R6.1");
      c.net("SCHMITT_IN", "R4.2", "R5.1", "U1B.+");
      c.net("VOL_TOP", "R6.2", "RV2.CW");
      c.net("VOL", "RV2.WIPER", "U1C.+");
      c.net("BUF_OUT", "U1C.OUT", "U1C.-", "C6.1");
      c.net("OUT_AC", "C6.2", "R7.1");
      c.net("LINE_OUT", "R7.2", "R8.1", "J2.T", "J2.R");
      c.net("SQ_AC", "C7.2", "R9.1");
      c.net("SQUARE_OUT", "R9.2", "R10.1", "J3.T", "J3.R");
    },
  ),
  make(
    "sheet-disconnected-groups",
    "Whole sheets",
    "Disconnected groups on one sheet",
    "Related circuits that share only rails: a buffered input, a load switch, a pulled-up I2C header, a power LED, bulk caps, and a mounting hole connected to nothing.",
    (c) => {
      c.res("R1", "1k").cap("C1", "10n").opamp("U1", "MCP6001").res("R2", "100").cap("C2", "100n");
      c.fet("Q1", "AO3400").res("R3", "100").res("R4", "100k").diode("D1", "1N4148");
      c.conn("J1", "LOAD", ["1:passive", "2:passive"]);
      c.conn("J2", "I2C", ["SCL", "SDA", "VCC:power_in", "GND:power_in"]);
      c.res("R5", "4k7").res("R6", "4k7");
      c.res("R7", "1k").led("D2", "green");
      c.cap("C3", "47u").cap("C4", "10u");
      c.conn("H1", "MTG", ["1"]);
      c.input("SENSE", "R1.1");
      c.net("FILT", "R1.2", "C1.1", "U1.+");
      c.net("BUF", "U1.OUT", "U1.-", "R2.1");
      c.output("ADC", "R2.2", "C2.1");
      c.input("DRIVE", "R3.1");
      c.net("GATE", "R3.2", "R4.1", "Q1.G");
      c.net("SW", "Q1.D", "D1.1", "J1.2");
      c.net("SCL", "J2.SCL", "R5.2");
      c.net("SDA", "J2.SDA", "R6.2");
      c.net("LED_A", "R7.2", "D2.1");
      c.rail("+12V", "D1.2", "J1.1");
      c.rail("+3V3", "U1.V+", "J2.VCC", "R5.1", "R6.1", "R7.1", "C3.1", "C4.1");
      c.gnd("GND", "C1.2", "U1.V-", "C2.2", "R4.2", "Q1.S", "J2.GND", "D2.2", "C3.2", "C4.2");
    },
  ),
  make(
    "sheet-upright-symbols",
    "Whole sheets",
    "Two-terminal symbols drawn upright",
    "The same kind of chain as elsewhere, but every resistor, capacitor and diode symbol is defined vertically. The layout must come out just as if they were horizontal.",
    (c) => {
      c.drawUpright();
      c.res("R1", "1k").cap("C1", "100n").res("R2", "10k").cap("C2", "10n");
      c.res("R3", "330").led("D1", "green").ind("L1", "10u").diode("D2", "BAT54");
      c.input("IN", "R1.1");
      c.net("A", "R1.2", "C1.1", "D2.2", "R2.1");
      c.net("B", "R2.2", "C2.1", "L1.1");
      c.output("OUT", "L1.2", "R3.1");
      c.net("LED", "R3.2", "D1.1");
      c.rail("+5V", "D2.1");
      c.gnd("GND", "C1.2", "C2.2", "D1.2");
    },
  ),
  make(
    "power-flagged-rails",
    "Power",
    "Rails flagged for ERC",
    "Rails from outside the block get a marker, which Partstyle draws as a PWR_FLAG. Each should find a free spot on its net without moving anything.",
    (c) => {
      c.conn("J1", "PWR", ["VIN:passive", "GND:passive"]);
      c.ic("U1", "MCP1700", { left: ["VIN:power_in"], right: ["VOUT:power_out"], bottom: ["GND"] });
      c.ic("U2", "SENSOR", { left: ["EN", "SCL"], top: ["VDD"], bottom: ["GND"] });
      c.cap("C1", "1u").cap("C2", "1u").cap("C3", "100n");
      c.input("ENABLE", "U2.EN");
      c.input("CLOCK", "U2.SCL");
      c.rail("+5V", "J1.VIN", "U1.VIN", "C1.1");
      c.rail("+3V3", "U1.VOUT", "C2.1", "U2.VDD", "C3.1");
      c.gnd("GND", "J1.GND", "U1.GND", "C1.2", "C2.2", "U2.GND", "C3.2");
      c.flag("+5V", "GND");
    },
  ),
  make(
    "power-enable-tied",
    "Power",
    "Regulator enable tied to its input",
    "An always-on LDO: EN sits just below VIN on the same side and joins it on the input rail, which a diode feeds. The two pins should share one symbol or wire, and stay connected.",
    (c) => {
      c.ic("U1", "AP2112K", {
        left: ["VIN:power_in", "EN"],
        right: ["VOUT:power_out"],
        bottom: ["GND"],
      });
      c.diode("D1", "BAT54").cap("C1", "1u").cap("C2", "1u").cap("C3", "1u");
      c.net("VBUS", "D1.1", "C3.1");
      c.rail("+5V", "D1.2", "U1.VIN", "U1.EN", "C1.1");
      c.rail("+3V3", "U1.VOUT", "C2.1");
      c.gnd("GND", "U1.GND", "C1.2", "C2.2", "C3.2");
      c.flag("VBUS", "GND");
    },
  ),
  make(
    "sheet-loose-parts",
    "Whole sheets",
    "Parts not wired yet",
    "A sheet part-way through: a regulator wired up, a resistor and two diodes connected to nothing, and a capacitor with only one end on a net. Every part must still be drawn, the loose ones set aside.",
    (c) => {
      c.ic("U1", "MCP1700", { left: ["VIN:power_in"], right: ["VOUT:power_out"], bottom: ["GND"] });
      c.cap("C1", "1u").cap("C2", "1u").cap("C3", "10u");
      c.res("R1", "10k").diode("D1", "1N4148").diode("D2", "SS14");
      c.rail("+5V", "U1.VIN", "C1.1");
      c.rail("+3V3", "U1.VOUT", "C2.1", "C3.1");
      c.gnd("GND", "U1.GND", "C1.2", "C2.2");
    },
  ),
];
