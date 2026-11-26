// Connects the machine (src/ts/machine) to the page: its messages go to the
// console, and the panels redraw when it says what has changed. Installed
// before anything runs; each call goes through the page's function by name
// at the time, so a function another file wraps is the wrapped one.

import { setMachineHost } from '../machine/host';
import { pipeReset } from '../machine/pipeline';
import { log } from './editor';
import { sourceLineForPc, uartClockTick } from './execution';
import { notePeripheralUse, renderUartTerminal, updateOledCanvas, updatePeripherals } from './peripherals';
import { syncUartSendControls } from './uart-controls';

// Run once the page has loaded every module (main.ts), in page order.
export function onMachineHostLoad() {
  setMachineHost({
    log: (text, level) => log(text, level),
    peripheralsChanged: () => updatePeripherals(),
    oledChanged: () => updateOledCanvas(),
    uartOutput: () => renderUartTerminal(),
    uartSettingsChanged: () => syncUartSendControls(),
    peripheralUsed: reg => notePeripheralUse(reg),
    resetPipeline: () => pipeReset(),
    clockTicked: () => uartClockTick(),
    sourceLine: pc => sourceLineForPc(pc),
    readInput: message => window.prompt(message),
  });
}
