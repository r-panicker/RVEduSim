// Panel tab switching, the Example menu and example loading, ASM/C language
// mode, and the C toolchain settings that invalidate a compiled program.

import { hdlDiscardTrace } from '../hdl/run';
import { initializeState } from '../machine/reset';
import { program, run, stepHistory, ui } from '../machine/state';
import { compilerConfig } from '../c/state';
import { redraw } from './views.svelte';
import { updateDisassembly, updateMachineCode } from './disassembly';
import { cLanguage, clearLog, editor, editorHistory, log, riscvLanguage, setStatus } from './editor';
import { editorState } from './editor-state';
import { applyExampleMemoryConfig, hideExecMarker, updateStats } from './execution';
import { updateMemoryView } from './memory-register-views';
import { escapeHtml, mobileMode, panelDock, refreshPanel, setMobileTab, setPanelChipShown, setPanelVisible, updateEditor, updateLineNumbers, updateRegisters } from './panels';
import { updatePeripherals } from './peripherals';
import { assembleOnly, resetAll, updateToolbarButtonStates } from './run-control';
import { waveApplyDockSize } from './waveform';
import { saveSettings } from './settings-store';
import { BUILTIN_EXAMPLES, exampleSources, initExampleSources, onExampleSourcesChange, readExampleSource, webSourceName, type ExampleEntry, type ExampleSourceState } from './example-sources';
import { byId } from './dom';
import { redrawToolbar, toolbar, type ExampleMenuGroup, type ExampleMenuItem } from './toolbar-state';
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

// The Example menu: one section per source (ui/example-sources.ts), in the
// editor's language, and a last entry that opens their settings. DIP to
// LED is built into the page in both languages (BAKED_ASM_EXAMPLE,
// BAKED_C_EXAMPLE), so the menu always has a program to open.

// Every example the menu offers now.
export function exampleEntries(): ExampleEntry[] {
  return [...BUILTIN_EXAMPLES, ...exampleSources.web.entries, ...exampleSources.local.entries];
}
export function findExample(key: string) { return exampleEntries().find(e => e.key === key) ?? null; }
// The memory depths an example declares in its index.txt, if any.
export function exampleDepths(key: string) { return findExample(key)?.depths ?? null; }

export const EXAMPLE_SOURCES_VALUE = '__sources';

function sourceItems(s: ExampleSourceState, lang: 'asm' | 'c'): ExampleMenuItem[] {
  const items = s.entries.filter(e => e.lang === lang).map(e => ({ value: e.key, label: e.label, title: e.desc }));
  if (items.length) return items;
  const note = s.status === 'loading' || s.status === 'idle' ? 'loading…'
    : s.status === 'error' ? 'unavailable: ' + s.error
    : lang === 'c' ? 'no C programs' : 'no assembly programs';
  return [{ value: '', label: note, title: note, disabled: true }];
}

export function updateExampleSelectorOptions() {
  const lang = editorState.language === 'c' ? 'c' : 'asm';
  toolbar.lang = lang;
  const groups: ExampleMenuGroup[] = [
    { label: 'Built in', items: sourceItems({ status: 'ok', error: '', entries: BUILTIN_EXAMPLES }, lang) },
    { label: webSourceName(), items: sourceItems(exampleSources.web, lang) },
  ];
  if (exampleSources.folder) groups.push({ label: exampleSources.folder.name, items: sourceItems(exampleSources.local, lang) });
  toolbar.examples = groups;
  redrawToolbar();
}
onExampleSourcesChange(updateExampleSelectorOptions);

// Resolves once the web source has been read the first time; loading an
// example by key waits for it, so a key from its index can be found.
let indexReady: () => void = () => {};
export const exampleIndexReady = new Promise<void>(resolve => { indexReady = resolve; });

// At boot, after the saved settings (the web URL among them) are back.
export function startExampleSources() {
  initExampleSources();
  const poll = () => (exampleSources.web.status === 'ok' || exampleSources.web.status === 'error') ? indexReady() : setTimeout(poll, 20);
  poll();
}

// The waveform strip lives at the bottom of the window on desktop, where it
// gets the full width a waveform needs. On mobile that puts it below the
// panels, so reaching it scrolls the toolbar off the screen and the run
// controls with it; there it is a sixth panel instead. Where it is drawn is
// the page's (App.svelte and Panel.svelte); this sets the in-panel styles.
export function syncWaveformPanelHost() {
  document.body.classList.toggle('wave-in-panel', mobileMode());
  if (typeof waveApplyDockSize === 'function' && document.body.dataset.booted) waveApplyDockSize();
}

// HDL mode is the only mode that produces waveforms, so the chip follows it
// the way Locals follows C mode.
export function updateWaveformPanelAvailability() {
  const show = mobileMode() && ui.engine === 'hdl';
  setPanelChipShown('waveform', show);
  if (!show && panelDock.waveform && panelDock.waveform.visible) {
    setPanelVisible('waveform', false);
  }
  syncWaveformPanelHost();
}

// Locals only has anything to show in C mode - the chip (and the panel
// itself, if it happened to be open) disappears in ASM mode rather than
// sitting there just to explain that it's not applicable.
export function updateLocalsPanelAvailability() {
  const isC = editorState.language === 'c';
  setPanelChipShown('locals', isC);
  if (!isC && panelDock.locals && panelDock.locals.visible) {
    setPanelVisible('locals', false);
  }
}

export function setLanguageMode(mode: 'asm' | 'c') {
  if (editorState.language === mode) return;
  editorState.language = mode;
  updateLocalsPanelAvailability();

  toolbar.lang = mode;
  redrawToolbar();

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

// A Compiler tab setting. The build on hand was made with the old value,
// so it is dropped. The M extension decides the -march flag.
const COMPILER_LABELS: Record<keyof typeof compilerConfig, string> = {
  compiler: 'Compiler', opt: 'Optimization level', archFlags: 'Architecture flags', useM: 'M extension',
};
export function setCompilerSetting<K extends keyof typeof compilerConfig>(key: K, value: (typeof compilerConfig)[K]) {
  if (compilerConfig[key] === value) return;
  compilerConfig[key] = value;
  if (key === 'useM') compilerConfig.archFlags = (value ? '-march=rv32im' : '-march=rv32i') + ' -mabi=ilp32';
  redraw('settings');
  invalidateCompiledProgram(COMPILER_LABELS[key]);
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
  let source: string;

  if (name === 'dip_led' || name === 'dip_led_c') {
    source = name === 'dip_led' ? BAKED_ASM_EXAMPLE : BAKED_C_EXAMPLE;
  } else {
    if (!findExample(name)) await exampleIndexReady;
    const entry = findExample(name);
    if (!entry) {
      setStatus(`No example '${name}' in the menu`, 'error');
      return;
    }
    const where = entry.source === 'local' ? 'the folder ' + (exampleSources.folder?.name ?? '') : webSourceName();
    setStatus(`Loading ${entry.label}\u2026`, 'info');
    try {
      source = await readExampleSource(entry);
    } catch (err) {
      if (myToken !== editorState.exampleLoadToken) return; // a newer selection already won
      log(`Could not load ${entry.file} from ${where}: ${errorMessage(err)}.` +
          (entry.source === 'web' && !window.rvNative && location.protocol === 'file:'
            ? ' A page opened as a file cannot fetch the examples beside it; serve it over http://, or use the hosted site. DIP to LED is built in.'
            : ''), 'error');
      setStatus(`Could not load '${entry.label}' \u2014 see the console`, 'error');
      updateToolbarButtonStates();
      return;
    }
  }
  if (myToken !== editorState.exampleLoadToken) return; // a newer selection already won

  const file = (findExample(name)?.file ?? '').split('/').pop();
  editorState.fileName = file || (name + (editorState.language === 'c' ? '.c' : '.asm'));
  toolbar.exampleKey = name;
  toolbar.userFile = null;
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
  saveSettings();
  if (editorState.language === 'asm') {
    assembleOnly(); // Auto-assemble on load so Run / Step are active immediately
  }
  const label = findExample(name)?.label ?? name;
  log(`Example loaded: ${label} (${editorState.fileName})`, 'info');
  setStatus('Example loaded: ' + label + (editorState.language === 'asm' && program.assembled ? ' (auto-assembled — ready to Run/Step)' : ''));
  updateToolbarButtonStates();
}
