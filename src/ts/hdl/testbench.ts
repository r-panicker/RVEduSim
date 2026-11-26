// The testbench the HDL engine wraps around the student's Wrapper.
//
// The generated testbench is program-independent: it contains no
// assembled code, no switch settings and no input data. Everything is
// supplied at RUN time through plusargs and through files in the
// simulation's working directory, which is what lets one compiled
// binary serve every run, every single-step and every input change.
//
// Emitted events are tagged `@@<kind>` so they can be told apart from
// whatever the student's own $display statements print.

import { ABI_NAMES } from '../isa/instructions';
import type { TimedByte, TimedInput } from './state';
import { hdlFindWrapper, hdlHex32, hdlModuleBody } from './verilog';

// The register bank's path: the Settings override, or what discovery finds
// (21-hdl-memory-images.ts).
declare function hdlRegBankPath(): string | null;

// One run's inputs, baked into a testbench that is downloaded to run on its
// own.
export interface TestbenchRun {
  cycles: number;
  base: { dip: number; pb: number; accel: number; adrdy: boolean };
  stim: TimedInput[];
  rx: TimedByte[];
}

export interface TestbenchOptions {
  run?: TestbenchRun | null;
  regBankPath?: string | null;
  doubleBuffer?: boolean;
}

// Double buffering is optional: it needs two extra Wrapper ports, and a
// Wrapper without them has to keep working. Both must be present -
// half the pair is a mistake, not a configuration.
export function hdlHasDoubleBuffer(src?: string): boolean {
  const w = (src === undefined) ? (hdlFindWrapper() || {}).src : src;
  if (!w) return false;
  const head = hdlModuleBody(w, 'Wrapper') || w;
  return /\bOLED_Swap\b/.test(head) && /\bOLED_SwapPending\b/.test(head);
}

export function hdlBuildTestbench(opts: TestbenchOptions = {}): string {
  // opts.run bakes one run's inputs in as the defaults (the download);
  // without it every setting arrives as a plusarg (the page's own runs).
  const run = opts.run || null;
  const h32 = (v: number) => "32'h" + hdlHex32(v);
  const runInit = run
    ? '\n  // The inputs recorded for this run, at the cycle each took effect.\n  initial begin\n' +
      run.stim.map((e, i) => `    stim_mem[${3 * i}] = ${h32(e.cycle)}; stim_mem[${3 * i + 1}] = ${h32(e.code)}; ` +
        `stim_mem[${3 * i + 2}] = ${h32(e.value)};\n`).join('') +
      run.rx.map((e, i) => `    rx_mem[${2 * i}] = ${h32(e.cycle)}; rx_mem[${2 * i + 1}] = ${h32(e.byte & 0xFF)};\n`).join('') +
      '  end\n'
    : '';
  const rb = ('regBankPath' in opts) ? opts.regBankPath : hdlRegBankPath();
  const dbuf = ('doubleBuffer' in opts) ? opts.doubleBuffer : hdlHasDoubleBuffer();
  // OLED_SwapPending is tied low: the VHDL that would hold it high across a
  // scanout is not simulated here, so a polling program never blocks -
  // the same model the JS engine uses.
  const dbufDecl = dbuf
    ? "  wire        OLED_Swap;\n  reg         OLED_Swap_d   = 1'b0;\n  wire        OLED_SwapPending = 1'b0;\n"
    : '';
  const dbufPorts = dbuf
    ? '    .OLED_Swap(OLED_Swap), .OLED_SwapPending(OLED_SwapPending),\n'
    : '';
  // dec_OLED_STATUS and MemRead are both combinational in the fixed
  // Wrapper, so together they name the cycle in which software read the
  // swap-pending flag. That is the only way the page can tell a program
  // that polls from one that does not.
  const dbufReport = dbuf
    ? '      if (OLED_Swap && !OLED_Swap_d && cyc - 1 >= trace_from) $display("@@B %0d", cyc - 1);\n' +
      '      OLED_Swap_d <= OLED_Swap;\n' +
      '      if (dut.MemRead && dut.dec_OLED_STATUS && cyc - 1 >= trace_from) $display("@@P %0d", cyc - 1);'
    : '';
  const arch = rb
    ? `  // Architectural register file, reached by hierarchical reference.
  // Writes are found by comparing against a shadow copy rather than by
  // watching the register file's write port, so only the array itself
  // has to be named and a renamed port cannot break the trace.
  reg [31:0] rf_shadow [0:31];
  integer j;
  always @(negedge CLK) begin
    if (!RESET && trace_lvl >= 2) begin
      for (j = 1; j < 32; j = j + 1)
        if (${rb}[j] !== rf_shadow[j]) begin
          if (cyc - 1 >= trace_from) $display("@@W %0d %0d %0h", cyc - 1, j, ${rb}[j]);
          rf_shadow[j] = ${rb}[j];
        end
    end
  end

  // Named aliases for the architectural registers. $dumpvars does not
  // write Verilog arrays, so without these the register file would be
  // missing from every waveform. Named x<n>_<abi> so either spelling
  // finds them.
${ABI_NAMES.map((n, i) => `  wire [31:0] x${i}_${n} = ${rb}[${i}];`).join('\n')}`
    : `  // No 32 x 32-bit register array could be located in the uploaded
  // sources, so the architectural register view is unavailable. Name the
  // path explicitly under Settings > Simulation to enable it.`;

  const about = run
    ? `// Testbench for one run - RVEduSim (HDL mode)
//
// It replays the inputs of the run it was saved from: the switch, button
// and accelerometer values at the start, every change made to them, and
// every byte typed into the UART console, each at the cycle it arrived,
// for ${run.cycles} cycles. The program itself is in AA_IROM.mem and
// AA_DMEM.mem, which your Wrapper reads; save them from the same Download
// menu, alongside this file. The plusargs below still override any
// setting.`
    : `// Generic testbench - RVEduSim (HDL mode)
//
// This file is program-independent. It holds no assembled code, no
// switch settings and no input data: every one of those is read at RUN
// time, so the same compiled binary is reused for each run, each
// single-step and each change of an input.`;
  const stim = run ? run.stim : [], rx = run ? run.rx : [], base = run ? run.base : null;

  return `\`timescale 1ns / 1ps
//====================================================================
${about}
//
//   plusargs     +CYCLES=<d> +TRACE=<d> +DIP=<h> +PB=<h> +ACCEL=<h>
//                +ADRDY=<h> +NSTIM=<d> +NRX=<d> +VCD
//                +VCDTOP (with +VCD: the testbench and Wrapper levels only)
//                +VCDFROM=<d> (start the waveform at that cycle)
//                +TRACEFROM=<d> (leave out every record before that cycle)
//                +LIVE (Verilator: inputs arrive while it runs, see below)
//                +LIVEFROM=<d> (with +LIVE: take no input before that cycle)
//   stim.mem     timed input changes : <cycle> <code> <value> triples,
//                codes 1=DIP 2=PB 3=ACCEL_Data 4=ACCEL_DReady
//   uart_rx.mem  timed UART input    : <cycle> <byte> pairs
//
// A timestamp means "in force DURING that cycle", so an input stamped at
// cycle C is already settled when the instruction of cycle C reads it. The
// value is therefore driven one clock edge earlier, at the edge that starts
// cycle C.
//
// Every setting has a working default, so this runs as it stands with
// no arguments at all:
//   iverilog -o sim *.v cg3207_hdl_tb.v && vvp sim
//
// TRACE levels: 0 silent, 1 peripherals only, 2 also the architectural
// trace - one @@I record per PC change, plus register and memory writes.
//====================================================================
module cg3207_hdl_tb;

  localparam integer STIM_MAX = 1024;
  localparam integer RX_MAX   = 4096;

  integer max_cycles = ${run ? run.cycles : 2000};
  integer trace_from = 0;
  integer vcd_from   = 0;
  integer trace_lvl  = ${run ? 1 : 2};
  integer pc_log     = 0;
  integer nstim      = ${stim.length};
  integer nrx        = ${rx.length};

  reg [31:0] stim_mem [0:3*STIM_MAX-1];
  reg [31:0] rx_mem   [0:2*RX_MAX-1];
${runInit}
  reg  [15:0] DIP           = 16'h${((base ? base.dip : 0) & 0xFFFF).toString(16).padStart(4, '0')};
  reg  [2:0]  PB            = 3'b${((base ? base.pb : 0) & 7).toString(2).padStart(3, '0')};
  wire [7:0]  LED_OUT;
  wire [6:0]  LED_PC;
  wire [31:0] SEVENSEGHEX;
  wire [7:0]  UART_TX;
  reg         UART_TX_ready = 1'b1;
  wire        UART_TX_valid;
  reg  [7:0]  UART_RX       = 8'h00;
  reg         UART_RX_valid = 1'b0;
  wire        UART_RX_ack;
  wire        OLED_Write;
  wire [6:0]  OLED_Col;
  wire [5:0]  OLED_Row;
  wire [23:0] OLED_Data;
${dbufDecl}  reg  [31:0] ACCEL_Data    = ${base ? h32(base.accel) : "32'h19000040"};
  reg         ACCEL_DReady  = 1'b${base && !base.adrdy ? 0 : 1};
  reg         RESET         = 1'b1;
  reg         CLK           = 1'b0;

  integer cyc = 0;
  reg [31:0] argv = 32'h0;

  // Named association, so a Wrapper whose ports are ordered differently - or
  // which lacks the optional double-buffering pair - still binds correctly.
  Wrapper dut(
    .DIP(DIP), .PB(PB), .LED_OUT(LED_OUT), .LED_PC(LED_PC),
    .SEVENSEGHEX(SEVENSEGHEX),
    .UART_TX(UART_TX), .UART_TX_ready(UART_TX_ready), .UART_TX_valid(UART_TX_valid),
    .UART_RX(UART_RX), .UART_RX_valid(UART_RX_valid), .UART_RX_ack(UART_RX_ack),
    .OLED_Write(OLED_Write), .OLED_Col(OLED_Col), .OLED_Row(OLED_Row),
    .OLED_Data(OLED_Data),
${dbufPorts}    .ACCEL_Data(ACCEL_Data), .ACCEL_DReady(ACCEL_DReady),
    .RESET(RESET), .CLK(CLK));

  always #5 CLK = ~CLK;

  //------------------------------------------------------------------
  // Runtime environment. Each setting keeps its default when the
  // matching plusarg is absent, so the testbench also stands alone.
  //------------------------------------------------------------------
  initial begin
    if ($value\$plusargs("CYCLES=%d", max_cycles)) begin end
    if ($value\$plusargs("TRACE=%d",  trace_lvl))  begin end
    if ($test\$plusargs("PCLOG")) pc_log = 1;
    if ($value\$plusargs("TRACEFROM=%d", trace_from)) begin end
    if ($value\$plusargs("NSTIM=%d", nstim) && nstim > 0) $readmemh("stim.mem", stim_mem);
    if ($value\$plusargs("NRX=%d",   nrx)   && nrx   > 0) $readmemh("uart_rx.mem", rx_mem);
    if ($value\$plusargs("DIP=%h",   argv)) DIP          = argv[15:0];
    if ($value\$plusargs("PB=%h",    argv)) PB           = argv[2:0];
    if ($value\$plusargs("ACCEL=%h", argv)) ACCEL_Data   = argv;
    if ($value\$plusargs("ADRDY=%h", argv)) ACCEL_DReady = argv[0];
  end

  initial begin
    if ($test\$plusargs("VCD")) begin
      if ($value\$plusargs("VCDFROM=%d", vcd_from) && vcd_from > 0) wait (cyc >= vcd_from);
      $dumpfile("dump.vcd");
      if ($test\$plusargs("VCDTOP")) begin
        $dumpvars(1, cg3207_hdl_tb);
        $dumpvars(1, cg3207_hdl_tb.dut);
      end else
        $dumpvars(0, cg3207_hdl_tb);
    end
  end

  //------------------------------------------------------------------
  // Timed input changes. Applying them on a clock edge keeps a run
  // reproducible: re-simulating the same timeline always replays the
  // same execution, which is what lets the UI step backwards and lets an
  // input be changed part-way through without losing your place.
  //
  // Compared against cyc+1: these are nonblocking assignments, so driving
  // at the edge that ENDS cycle C-1 is what makes the value settled
  // throughout cycle C, where the instruction of cycle C reads it.
  //------------------------------------------------------------------
  integer stim_i = 0;
  always @(posedge CLK) begin
    if (!RESET) begin
      while (stim_i < nstim && stim_mem[3*stim_i] <= cyc + 1) begin
        case (stim_mem[3*stim_i+1])
          32'd1: DIP          <= stim_mem[3*stim_i+2][15:0];
          32'd2: PB           <= stim_mem[3*stim_i+2][2:0];
          32'd3: ACCEL_Data   <= stim_mem[3*stim_i+2];
          32'd4: ACCEL_DReady <= stim_mem[3*stim_i+2][0];
        endcase
        stim_i = stim_i + 1;
      end
    end
  end

\`ifdef VERILATOR
\`begin_keywords "1800-2017"
  //------------------------------------------------------------------
  // Live runs (the desktop app, with Verilator). At every rising edge the
  // app's pending commands are taken: an input change is driven now, which
  // puts it in force from cycle cyc+1 exactly as a stim.mem entry stamped
  // cyc+1 would be, and reported with that stamp so that a replay of the
  // recorded timeline reproduces the run. A UART byte goes onto the receive
  // feed no sooner than the edge after this one, and a gap after the last.
  //------------------------------------------------------------------
  import "DPI-C" function int cg3207_live_poll(input int cycle, input int from,
                                               output int code, output int value);
  // $dumpflush and $dumpoff compile to nothing in Verilator; the helper
  // flushes (1) or closes (0) the dump instead.
  import "DPI-C" context function void cg3207_vcd(input int op);
  integer live = 0, live_from = 0, live_code, live_value, live_at;
  initial if ($test\$plusargs("LIVE")) begin
    live = 1;
    if ($value\$plusargs("LIVEFROM=%d", live_from)) begin end
  end
  always @(posedge CLK) begin
    if (!RESET && live) begin
      while (cg3207_live_poll(cyc, live_from, live_code, live_value) != 0) begin
        case (live_code)
          1: DIP          <= live_value[15:0];
          2: PB           <= live_value[2:0];
          3: ACCEL_Data   <= live_value;
          4: ACCEL_DReady <= live_value[0];
          5: begin
               live_at = cyc + 2;
               if (nrx > 0 && rx_mem[2*nrx-2] + (live_value >>> 8) > live_at)
                 live_at = rx_mem[2*nrx-2] + (live_value >>> 8);
               rx_mem[2*nrx]   = live_at;
               rx_mem[2*nrx+1] = live_value & 32'hFF;
               nrx = nrx + 1;
               $display("@@U %0d %0h", live_at, live_value & 32'hFF);
             end
          6: max_cycles = cyc + 1;
          7: cg3207_vcd(1);
          8: cg3207_vcd(0);
          9: $display("@@C %0d %0h", cyc, dut.PC);
          default: ;
        endcase
        if (live_code >= 1 && live_code <= 4) $display("@@V %0d %0d %0h", cyc + 1, live_code, live_value);
      end
    end
  end
\`end_keywords
\`endif

  //------------------------------------------------------------------
  // UART receive feed - stands in for the holding register in the top level
  // module for synthesis, and follows it rather than being kind. A byte arrives when its timestamp
  // says so, whether or not the program has read the previous one; if it has
  // not, the arriving byte is DISCARDED and the older one kept, with nothing
  // to tell software it happened. Waiting for UART_RX_ack before offering the
  // next byte would be back-pressure, which a wire cannot apply.
  //------------------------------------------------------------------
  integer rx_i = 0;
  always @(posedge CLK) begin
    if (RESET) begin
      rx_i          <= 0;
      UART_RX_valid <= 1'b0;
    end else begin
      if (UART_RX_ack)
        UART_RX_valid <= 1'b0;
      if (rx_i < nrx && rx_mem[2*rx_i] <= cyc + 1) begin
        rx_i <= rx_i + 1;                       // consumed from the wire either way
        if (!UART_RX_valid || UART_RX_ack) begin
          UART_RX       <= rx_mem[2*rx_i+1][7:0];
          UART_RX_valid <= 1'b1;
        end
        // else: overrun, the byte is lost and the held one survives
      end
    end
  end

  //------------------------------------------------------------------
  // Architectural trace. One @@I record per PC change, so it stays
  // correct if the core is made multi-cycle or pipelined - WE_PC is
  // hardwired to 1 in the single-cycle template, but need not be.
  //
  // Everything referenced here is declared in the FIXED Wrapper, so this
  // part works for any implementation of the core behind it.
  //------------------------------------------------------------------
  reg [31:0] pc_prev = 32'hxxxxxxxx;
  always @(posedge CLK) begin
    if (!RESET && trace_lvl >= 2) begin
      if (dut.PC !== pc_prev) begin
        if (cyc >= trace_from) $display("@@I %0d %0h %0h", cyc, dut.PC, dut.Instr);
        pc_prev <= dut.PC;
      end
      if (|dut.MemWrite_out && cyc >= trace_from)
        $display("@@M %0d %0h %0h %0h", cyc, dut.ALUResult, dut.MemWrite_out, dut.WriteData_out);
    end
  end

  // Without the trace, +PCLOG reports each change of PC (@@C), so that Real
  // time at a slow clock shows LED[15:9] counting.
  reg [31:0] pc_logged = 32'hxxxxxxxx;
  always @(posedge CLK) begin
    if (!RESET && trace_lvl == 1 && pc_log && dut.PC !== pc_logged) begin
      if (cyc >= trace_from) $display("@@C %0d %0h", cyc, dut.PC);
      pc_logged <= dut.PC;
    end
  end

${arch}

  //------------------------------------------------------------------
  // Peripheral monitors, sampled on the FALLING edge.
  //
  // Every one of these is declared "output reg" in the Wrapper: the write
  // made by the instruction of cycle C lands at the edge that ends C and is
  // only readable during C+1. Sampling on the falling edge of C+1 reads it
  // while the trace still sits inside step C, so the effect is attributed to
  // the instruction that caused it.
  //
  // MemWrite_out is different - it is combinational and is therefore still
  // sampled on the rising edge, above, alongside the instruction record.
  //------------------------------------------------------------------
  reg [7:0]  led_prev = 8'hxx;
  reg [31:0] ss_prev  = 32'hxxxxxxxx;

  always @(negedge CLK) begin
    if (!RESET && trace_lvl >= 1) begin
      if (LED_OUT !== led_prev) begin
        if (cyc - 1 >= trace_from) $display("@@L %0d %0h", cyc - 1, LED_OUT);
        led_prev <= LED_OUT;
      end
      if (SEVENSEGHEX !== ss_prev) begin
        if (cyc - 1 >= trace_from) $display("@@S %0d %0h", cyc - 1, SEVENSEGHEX);
        ss_prev <= SEVENSEGHEX;
      end
      if (UART_TX_valid && cyc - 1 >= trace_from) $display("@@T %0d %0h", cyc - 1, UART_TX);
      if (OLED_Write && cyc - 1 >= trace_from)    $display("@@O %0d %0d %0d %0h", cyc - 1, OLED_Col, OLED_Row, OLED_Data);
${dbufReport}
      // The processor has taken the pending RX byte, so the byte leaves the
      // console's queue. Without this the UI could never clear RX_VALID.
      if (UART_RX_ack && cyc - 1 >= trace_from) $display("@@A %0d", cyc - 1);
    end
  end

  always @(posedge CLK) cyc <= cyc + 1;

  //------------------------------------------------------------------
  // Stimulus
  //------------------------------------------------------------------
  initial begin
    #12;
    RESET = 1'b0;
    wait (cyc >= max_cycles);
    // One more falling edge, so the effects of the final instruction are
    // reported instead of being lost to $finish.
    @(negedge CLK);
    // @@N is the instruction the core would fetch next. It is what lets the
    // UI show a sensible PC once the whole recording has been stepped through.
    $display("@@N %0d %0h %0h", cyc, dut.PC, dut.Instr);
    $display("@@F %0d %0h %0h %0h", cyc, LED_OUT, SEVENSEGHEX, LED_PC);
    $finish;
  end

endmodule
`;
}
