// @ts-nocheck
// Connects the machine (src/ts/machine) to the page: its messages go to the
// console, and the panels redraw when it says what has changed. Installed
// before anything runs; each call goes through the page's function by name
// at the time, so a function another file wraps is the wrapped one.
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
