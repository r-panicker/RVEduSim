// Panel tab switching, the Example menu and example loading, ASM/C language
// mode, and the C toolchain settings that invalidate a compiled program.

import { hdlDiscardTrace } from '../hdl/run';
import { initializeState } from '../machine/reset';
import { program, run, stepHistory } from '../machine/state';
import { updateDisassembly, updateMachineCode } from './disassembly';
import { cLanguage, clearLog, editor, editorHistory, log, riscvLanguage, setStatus } from './editor';
import { editorState } from './editor-state';
import { applyExampleMemoryConfig, hideExecMarker, updateStats } from './execution';
import { updateMemoryView } from './memory-register-views';
import { escapeHtml, mobileMode, panelDock, refreshPanel, setMobileTab, setPanelVisible, updateEditor, updateLineNumbers, updateRegisters } from './panels';
import { updatePeripherals } from './peripherals';
import { assembleOnly, resetAll, updateToolbarButtonStates } from './run-control';
import { waveApplyDockSize } from './waveform';
import { byId } from './dom';
import { errorMessage } from '../errors';

// A tab-style entry point for callers that name a panel. Panels are independent,
// and a caller of switchTab() wants the named panel shown, so this makes it
// visible and refreshes it rather than toggling. On mobile (≤800px) the
// tabbed view is active, so it also switches the visible tab.
export function switchTab(tab: string) {
  if (panelDock[tab]) {
    if (mobileMode()) setMobileTab(tab);
    if (!panelDock[tab].visible) setPanelVisible(tab, true);
    else refreshPanel(tab);
  }
}

// Built-in examples. Every example is a file in examples/asm/ or
// examples/c/, fetched by loadExample() (see EXAMPLE_FILENAMES). DIP to LED
// is also built into the page, in both languages (BAKED_ASM_EXAMPLE,
// BAKED_C_EXAMPLE), so its source loads with no server at all; compiling
// the C one still needs the network for Godbolt, as every C example does.

// The Example menu is read from examples/index.txt, not written out here -
// adding a program is a row in that file plus the file itself, no source
// edit. Plain .txt, not .md: static site generators that serve the repo
// tend to render .md through a Markdown->HTML pipeline instead of serving
// it verbatim, which would break this fetch - .txt is never touched.
// Each row is `| key | lang | label | file | irom | dmem | description |`;
// loadExampleIndex() parses it into EXAMPLE_MENU (for the dropdown),
// EXAMPLE_FILENAMES (for the fetch path and the Save filename) and
// EXAMPLE_DEPTHS (the memory sizes the program needs). Until that
// fetch resolves - and permanently, over file://, where it never will -
// all three fall back to just the one baked example in each language, so
// the dropdown is never genuinely empty.
export const DEFAULT_DEPTH_BITS = 9;
// Each language's menu: [key, label, description].
export let EXAMPLE_MENU: Record<'asm' | 'c', [string, string, string][]> = {
  asm: [['dip_led', 'DIP to LED (start here)', 'DIP to LED — the one example baked into the page, works with no server']],
  c: [['dip_led_c', 'DIP to LED (start here)', 'DIP switches mirrored to LEDs — the one C example baked into the page, works with no server']],
};
export let EXAMPLE_FILENAMES: Record<string, string> = { dip_led: 'DIP_to_LED.asm', dip_led_c: 'DIP_to_LED.c' };
export let EXAMPLE_DEPTHS: Record<string, { irom: number; dmem: number; lang?: 'asm' | 'c' }> = {
  dip_led: { irom: 9, dmem: 9 },
  dip_led_c: { irom: 9, dmem: 9 },
};

// Parses the simple markdown table format above into
// [key, lang, label, file, irom, dmem, description] rows. Only structure
// matters, not header wording: the first all-dashes row (markdown's
// column-alignment row) marks the start of real data, so a row before it
// is a header regardless of its text.
// A row: key, language, label, file, IROM bits, DMEM bits, description.
export type ExampleRow = [string, string, string, string, number, number, string];

export function parseExampleIndexMarkdown(text: string) {
  const rows: ExampleRow[] = [];
  let dataStarted = false;
  for (let line of String(text || '').split('\n')) {
    line = line.trim();
    if (!line.startsWith('|')) continue;
    line = line.slice(1);
    if (line.endsWith('|')) line = line.slice(0, -1);
    const cells = line.split('|').map(c => c.trim());
    if (!dataStarted) {
      if (cells.length && cells.every(c => /^:?-+:?$/.test(c))) dataStarted = true;
      continue;
    }
    if (cells.length < 7 || !cells[0]) continue;
    const bits = (c: string, fallback: number) => {
      const n = parseInt(c, 10);
      return (Number.isFinite(n) && n >= 2 && n <= 30) ? n : fallback;
    };
    rows.push([cells[0], cells[1], cells[2], cells[3],
               bits(cells[4], DEFAULT_DEPTH_BITS), bits(cells[5], DEFAULT_DEPTH_BITS),
               cells.slice(6).join(' | ')]);
  }
  return rows;
}

export async function loadExampleIndex() {
  try {
    const resp = await fetch('examples/index.txt');
    if (!resp.ok) return;
    const rows = parseExampleIndexMarkdown(await resp.text());
    if (!rows.length) return;
    const menu: typeof EXAMPLE_MENU = { asm: [], c: [] };
    for (const [key, lang, label, file, irom, dmem, desc] of rows) {
      const l = (lang === 'c') ? 'c' : 'asm';
      menu[l].push([key, label, desc]);
      EXAMPLE_FILENAMES[key] = file;
      EXAMPLE_DEPTHS[key] = { irom: irom, dmem: dmem, lang: l };
    }
    for (const l of ['asm', 'c'] as const) if (menu[l].length) EXAMPLE_MENU[l] = menu[l];
  } catch (err) { /* index.txt unreachable (e.g. file://) - stay on the fallback */ }
  updateExampleSelectorOptions();
}
// Captured so loadExample() can await it - a non-baked key looked up in
// EXAMPLE_FILENAMES before this resolves would build its fetch URL from
// the two-entry fallback and 404 on a real example, e.g. `fact` fetched
// as `fact.asm` instead of `factorial.asm`.
export const exampleIndexReady = loadExampleIndex();

export function updateExampleSelectorOptions() {
  const select = byId<HTMLSelectElement>('exampleSelect');
  if (!select) return;
  const menu = EXAMPLE_MENU[editorState.language === 'c' ? 'c' : 'asm'];
  select.innerHTML = menu.map(([value, label, title]) =>
    `<option value="${value}" title="${escapeHtml(title)}">${escapeHtml(label)}</option>`
  ).join('');
}

// The waveform strip lives at the bottom of the window on desktop, where it
// gets the full width a waveform needs. On mobile that puts it below the
// panels, so reaching it scrolls the toolbar off the screen and the run
// controls with it; there it becomes a sixth panel instead, and is moved
// into the stack rather than duplicated so all of its wiring still applies.
export function syncWaveformPanelHost() {
  const dock = byId('waveDock');
  const host = byId('tab-waveform');
  const resizer = byId('waveResizer');
  if (!dock || !host) return;
  const body = host.querySelector(':scope > .panel-body') || host;
  const wantMobile = mobileMode();
  const isInPanel = host.contains(dock);
  if (wantMobile && !isInPanel) {
    body.appendChild(dock);
  } else if (!wantMobile && isInPanel) {
    // Back to its own place at the bottom, immediately after its resizer.
    if (resizer && resizer.parentNode) resizer.parentNode.insertBefore(dock, resizer.nextSibling);
  }
  document.body.classList.toggle('wave-in-panel', wantMobile);
  if (typeof waveApplyDockSize === 'function' && document.body.dataset.booted) waveApplyDockSize();
}

// HDL mode is the only mode that produces waveforms, so the chip follows it
// the way Locals follows C mode.
export function updateWaveformPanelAvailability() {
  const chip = byId<HTMLButtonElement>('panelChip-waveform');
  // Read the engine off its toggle rather than the variable: this runs from
  // initPanelDock(), which is called before `simEngineMode` is declared
  // (in hdl/engine.ts).
  const hdlBtn = byId<HTMLButtonElement>('engBtnHdl');
  const show = mobileMode() && !!(hdlBtn && hdlBtn.classList.contains('active'));
  if (chip) chip.style.display = show ? '' : 'none';
  if (!show && panelDock.waveform && panelDock.waveform.visible) {
    setPanelVisible('waveform', false);
  }
  syncWaveformPanelHost();
}

// Locals only has anything to show in C mode - the chip (and the panel
// itself, if it happened to be open) disappears in ASM mode rather than
// sitting there just to explain that it's not applicable.
export function updateLocalsPanelAvailability() {
  const chip = byId<HTMLButtonElement>('panelChip-locals');
  const isC = editorState.language === 'c';
  if (chip) chip.style.display = isC ? '' : 'none';
  if (!isC && panelDock.locals && panelDock.locals.visible) {
    setPanelVisible('locals', false);
  }
}

export function setLanguageMode(mode: 'asm' | 'c') {
  if (editorState.language === mode) return;
  editorState.language = mode;
  updateLocalsPanelAvailability();

  const btnAsm = byId<HTMLButtonElement>('langBtnAsm');
  const btnC = byId<HTMLButtonElement>('langBtnC');
  if (btnAsm) btnAsm.classList.toggle('active', mode === 'asm');
  if (btnC) btnC.classList.toggle('active', mode === 'c');

  if (editorState.cm && editorState.languageCompartment) {
    editorState.cm.dispatch({
      effects: editorState.languageCompartment.reconfigure(mode === 'c' ? cLanguage : riscvLanguage)
    });
  }

  updateExampleSelectorOptions();


  if (mode === 'c') {
    loadExample('dip_led_c');
    setStatus('Switched to C Mode. Click ⚙ Compile to build with Compiler Explorer (Godbolt).', 'info');
  } else {
    loadExample('dip_led');
    setStatus('Switched to RISC-V Assembly Mode.', 'info');
  }

  if (typeof updateToolbarButtonStates === 'function') updateToolbarButtonStates();
}

// The compiled program is a product of the toolchain settings, so any
// change to them makes what is currently loaded stale. Drop it and make
// the user rebuild rather than leave a program running that no longer
// corresponds to the settings on screen.
export function invalidateCompiledProgram(what: string) {
  if (typeof run.running !== 'undefined' && run.running) {
    run.running = false;
    if (run.timerId) { clearTimeout(run.timerId); run.timerId = null; }
  }
  if (typeof hdlDiscardTrace === 'function') hdlDiscardTrace();
  const hadProgram = program.assembled || (program.machineCode && program.machineCode.length);
  program.assembled = false;
  editorState.lastAssembledCode = null;
  program.machineCode = [];
  initializeState();
  stepHistory.entries = [];
  run.currentLine = -1;
  run.finished = false;
  if (typeof hideExecMarker === 'function') hideExecMarker();
  updateRegisters(); updateMemoryView(); updateDisassembly();
  updateMachineCode(); updateStats(); updatePeripherals();
  updateToolbarButtonStates();
  if (hadProgram) {
    log(what + ' changed — the program was cleared. ' +
        (editorState.language === 'c' ? 'Compile' : 'Assemble') + ' again.', 'warn');
    setStatus(what + ' changed — ' +
      (editorState.language === 'c' ? 'compile' : 'assemble') + ' again', 'warn');
  }
}

// Wire every toolchain control to that. Doing it here rather than with
// inline handlers keeps the markup free of duplicated calls.
export function initCompilerSettingWatchers() {
  const watch = (id: string, ev: string, label: string) => {
    const el = document.getElementById(id);
    if (el) el.addEventListener(ev, () => invalidateCompiledProgram(label));
  };
  watch('godboltCompilerSelect', 'change', 'Compiler');
  watch('godboltOptSelect', 'change', 'Optimization level');
  watch('godboltUseM', 'change', 'M extension');
  watch('godboltArchFlags', 'change', 'Architecture flags');
}

export function syncGodboltArchFlags() {
  const cb = byId<HTMLInputElement>('godboltUseM');
  const input = byId<HTMLInputElement>('godboltArchFlags');
  if (!input) return;
  const useM = cb ? cb.checked : false;
  const march = useM ? '-march=rv32im' : '-march=rv32i';
  input.value = march + ' -mabi=ilp32';
}

export function resetCompilerConfig() {
  const selComp = byId<HTMLSelectElement>('godboltCompilerSelect');
  const selOpt = byId<HTMLSelectElement>('godboltOptSelect');
  const inputArch = byId<HTMLInputElement>('godboltArchFlags');
  const useMCheck = byId<HTMLInputElement>('godboltUseM');
  if (selComp) selComp.value = 'rv32-cclang2010';
  if (selOpt) selOpt.value = '-O0';
  if (useMCheck) useMCheck.checked = true;
  if (inputArch) inputArch.value = '-march=rv32im -mabi=ilp32';
  setStatus('Reset Godbolt compiler settings to default (Clang 20.1, -O0)', 'info');
}

// DIP to LED, built into the page - see "Built-in examples" above.
export const BAKED_ASM_EXAMPLE = `#----------------------------------------------------------------------------------
#--	MIT License
#--
#--	Copyright (c) 2020 Rajesh Panicker
#--
#--	Permission is hereby granted, free of charge, to any person obtaining a copy
#--	of this software and associated documentation files (the "Software"), to deal
#--	in the Software without restriction, including without limitation the rights
#--	to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
#--	copies of the Software, and to permit persons to whom the Software is
#--	furnished to do so, subject to the following conditions:
#--
#--	The above copyright notice and this permission notice shall be included in all
#--	copies or substantial portions of the Software.
#--
#--	THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
#--	IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
#--	FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
#--	AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
#--	LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
#--	OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
#--	SOFTWARE.
#--
#--	Not a condition of the license, but if you find this code useful, an email to
#--	rajesh.panicker <at> u.nus.edu briefly mentioning its use would be appreciated.
#----------------------------------------------------------------------------------

# This sample program for RISC-V simulation using RARS

# Memory this program needs: IROM_DEPTH_BITS 9, DMEM_DEPTH_BITS 9
# (2**9 = 512 bytes of code, 2**9 = 512 bytes of data). The simulator sets its
# Linker segments from these when you pick the example; set the same two
# localparams in Wrapper.v. Change both if you change the program.

.eqv MMIO_BASE 0xFFFF0000
# Memory-mapped peripheral register offsets
.eqv UART_RX_VALID_OFF 			0x00 #RO, status bit
.eqv UART_RX_OFF			0x04 #RO
.eqv UART_TX_READY_OFF			0x08 #RO, status bit
.eqv UART_TX_OFF			0x0C #WO
.eqv OLED_COL_OFF			0x20 #WO
.eqv OLED_ROW_OFF			0x24 #WO
.eqv OLED_DATA_OFF			0x28 #WO
.eqv OLED_CTRL_OFF			0x2C #WO
.eqv OLED_STATUS_OFF		0x30 #RO, status bit
.eqv ACCEL_DATA_OFF			0x40 #RO
.eqv ACCEL_DREADY_OFF			0x44 #RO, status bit
.eqv DIP_OFF				0x64 #RO
.eqv PB_OFF				0x68 #RO
.eqv LED_OFF				0x60 #WO
.eqv SEVENSEG_OFF			0x80 #WO
.eqv CYCLECOUNT_OFF			0xA0 #RO

# ------- <code memory (Instruction Memory ROM) begins>
.text	## IROM segment: IROM_BASE to IROM_BASE+2^IROM_DEPTH_BITS-1
# Total number of real instructions should not exceed 2^IROM_DEPTH_BITS/4 (127 excluding the last line 'halt B halt' if IROM_DEPTH_BITS=9).
# Pseudoinstructions (e.g., li, la) may be implemented using more than one actual instruction. See the assembled code in the Execute tab of RARS.

# You can also use the actual register numbers directly. For example, instead of s1, you can write x9

main:
	li s0, MMIO_BASE		# MMIO_BASE. Implemented as lui+addi
	# Could have done lw s0,MMIO_BASE (ARM style) instead of the li above, provided MMIO_BASE: .word 0xFFFF0000 was declared in the .data (DMEM) section instead of .eqv
	addi s1, s0, LED_OFF		# LED address = MMIO_BASE + LED_OFF
	li  s2, DIP_OFF			# note that this li doesn't translate to lui, unlike the li in line 41.
	add s2, s0, s2			# DIP address = MMIO_BASE + DIP_OFF. Could have been done in a way similar to LED address, but done this way to have a DP reg instruction
loop:
	lw s3, delay_val		# reading the loop counter value
	lw s4, (s2)			# reading DIPS
	sw s4, (s1)			# writing to LEDS

wait:
	addi s3, s3, -1		# subtract 1
	beq s3, zero, loop	# exit the loop
	jal zero, wait		# continue in the loop (could also have written j wait).

halt:	
	j halt		# infinite loop to halt computation. A program should not "terminate" without an operating system to return control to
				# keep halt: j halt as the last line of your code so that there is a 'dead end' beyond which execution will not proceed.
				
# ------- <code memory (Instruction Memory ROM) ends>			
				
								
#------- <Data Memory begins>									
.data  ## DMEM segment: DMEM_BASE to DMEM_BASE+2^DMEM_DEPTH_BITS-1
# Total number of constants+variables should not exceed 2^DMEM_DEPTH_BITS/4 (128 if DMEM_DEPTH_BITS=9).

DMEM:

delay_val: .word 4	# a constant, at location DMEM+0x00
string1:
.asciz "\\r\\nWelcome to CG3207..\\r\\n"	# string, from DMEM+0x4 to DMEM+0x18 (word address, including null character. The last character is at a byte address 0x1B).
var1: .word	1 		# a statically allocated variable (which can have an initial value, say 1), at location DMEM+0x1C
# Food for thought: What will be the address of var1 if string1 had one extra character, say  "..." instead of ".."? Hint: words are word-aligned.

.align 9	# To set the address at this point to be 512-byte aligned, i.e., DMEM+0x200
STACK_INIT:	# Stack pointer can be initialised to this location - DMEM+0x200 (i.e., the address of stack_top)
			# stack grows downwards, so stack pointer should be decremented when pushing and incremented when popping (if the stack is full-descending). Stack can be used for function calls and local variables.
		# Not allocating any heap, as it is unlikely to be used in this simple program. If we need dynamic memory allocation,we need to allocate memory and imeplement a heap manager.
#------- <Data Memory ends>													
`;
export const BAKED_C_EXAMPLE = `// DIP switches mirrored to LEDs, continuously (C translation of DIP_to_LED.asm)

// Memory this program needs: IROM_DEPTH_BITS 9, DMEM_DEPTH_BITS 9
// (2**9 = 512 bytes of code, 2**9 = 512 bytes of data). The simulator sets its
// Linker segments from these when you pick the example; set the same two
// localparams in Wrapper.v. Change both if you change the program.

#define MMIO_BASE 0xFFFF0000   // Should be the same as the .mmio address based on the Memory Configuration set in the assembler/linker, and Wrapper.v

// Memory-mapped peripheral register offsets
#define UART_RX_VALID_OFF	0x00 //RO, status bit
#define UART_RX_OFF 		0x04 //RO
#define UART_TX_READY_OFF	0x08 //RO, status bit
#define UART_TX_OFF 		0x0C //WO
#define OLED_COL_OFF 		0x20 //WO
#define OLED_ROW_OFF 		0x24 //WO
#define OLED_DATA_OFF 		0x28 //WO
#define OLED_CTRL_OFF 		0x2C //WO 
#define OLED_STATUS_OFF 	0x30 //RO, status bit
#define ACCEL_DATA_OFF 		0x40 //RO
#define ACCEL_DREADY_OFF 	0x44 //RO, status bit
#define LED_OFF 			0x60 //WO
#define DIP_OFF 			0x64 //RO
#define PB_OFF  			0x68 //RO
#define SEVENSEG_OFF 		0x80 //WO
#define CYCLECOUNT_OFF 		0xA0 //RO

#define DELAY_COUNT 4 // matches the wait loop in DIP_to_LED.asm

int main()
{
    volatile unsigned int* DIP_ADDR = (unsigned int*) (MMIO_BASE+DIP_OFF);
    volatile unsigned int* LED_ADDR = (unsigned int*) (MMIO_BASE+LED_OFF);

    while (1)
    {
        *LED_ADDR = *DIP_ADDR;   // mirror the switches onto the LEDs

        // small delay before sampling again, so the LEDs are not being
        // rewritten on literally every cycle
        for (volatile unsigned int i = DELAY_COUNT; i > 0; i--);
    }
    return 0;
}
`;

export async function loadExample(name: string) {
  const myToken = ++editorState.exampleLoadToken;
  let source;

  if (name === 'dip_led' || name === 'dip_led_c') {
    // Built in, so it loads with no server - see "Built-in examples" at
    // the top of this file.
    source = name === 'dip_led' ? BAKED_ASM_EXAMPLE : BAKED_C_EXAMPLE;
  } else {
    await exampleIndexReady; // don't build the URL off the two-entry fallback
    const lang = editorState.language === 'c' ? 'c' : 'asm';
    const fileName = EXAMPLE_FILENAMES[name] || (name + '.' + lang);
    const url = 'examples/' + lang + '/' + fileName;
    setStatus(`Loading ${fileName}\u2026`, 'info');
    try {
      const resp = await fetch(url);
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      source = await resp.text();
    } catch (err) {
      if (myToken !== editorState.exampleLoadToken) return; // a newer selection already won
      log(`Could not load '${url}': ${errorMessage(err)}. Every example but DIP to LED is ` +
          `loaded from a file next to the page, which needs it served over ` +
          `http:// (a local server, or the hosted deployment) \u2014 opening the ` +
          `file directly (file://) blocks that fetch. DIP to LED needs no server.`, 'error');
      setStatus(`Could not load '${name}' \u2014 see the console`, 'error');
      updateToolbarButtonStates();
      return;
    }
  }
  if (myToken !== editorState.exampleLoadToken) return; // a newer selection already won

  if (editorState.language === 'c') {
    editorState.fileName = EXAMPLE_FILENAMES[name] || (name.endsWith('.c') ? name : name + '.c');
  } else {
    editorState.fileName = EXAMPLE_FILENAMES[name] || (name + '.asm');
  }
  editor.value = source;
  editorState.lastAssembledCode = null;
  program.assembled = false;
  editor.scrollTop = 0;
  editor.scrollLeft = 0;
  run.breakpoints.clear();
  resetAll();
  editorHistory.initialState();
  updateEditor();
  updateLineNumbers();
  clearLog();
  applyExampleMemoryConfig(name); // before assembling: the segment sizes gate it
  if (editorState.language === 'asm') {
    assembleOnly(); // Auto-assemble on load so Run / Step are active immediately
  }
  log(`Example loaded: ${name} (${editorState.fileName})`, 'info');
  setStatus('Example loaded: ' + name + (editorState.language === 'asm' && program.assembled ? ' (auto-assembled — ready to Run/Step)' : ''));
  updateToolbarButtonStates();
}
