<script lang="ts">
  // The Peripherals panel. What it shows comes from periphDisplay() in
  // peripherals.ts, re-read whenever the panel is told to redraw; what it
  // does on a click or a key is in peripherals.ts too.
  import { viewRev } from './views.svelte';
  import {
    LED_CELLS, PB_BUTTONS, SEGMENT_PATHS, periphDisplay, togglePeriphFold, toggleDip, pbToggle,
    sendUartInput, clearUartTx, setUartInputMode, updateAccelValues, setAccelPreset, clearOledDisplay
  } from './peripherals';
  import { setUartSendMode, setUartCharInstr } from '../machine/uart';

  const d = $derived.by(() => { viewRev.peripherals; return periphDisplay(); });
</script>

<div class="peripherals-grid">
  <!-- LEDs & DIP Switches Section (Top) -->
  <div class="periph-section" data-periph="ledDip" class:periph-folded={d.folded('ledDip')}>
    <div class="periph-title" onclick={() => togglePeriphFold('ledDip')}
      title="LED[15:9] = PC[8:2], LED[8] = Clock, LED[7:0] = User Output (0xFFFF0060 WO). DIP[15:0] = Switches (0xFFFF0064 RO).">
      LEDs (LED[15:0]) &amp; DIP Switches (SW[15:0])
    </div>
    <div class="periph-board">
      <div class="periph-group-labels">
        <span class="lbl-pc">PC[8:2] (LED[15:9])</span>
        <span class="lbl-clk">CLK (LED[8])</span>
        <span class="lbl-user">User OUT (LED[7:0]) <span class="periph-addr">0xFFFF0060 WO</span></span>
      </div>
      <div class="led-row" id="ledRow">
        {#each LED_CELLS as c (c.i)}
          <div class="led-cell">
            <div class="led-sublabel">{c.label}</div>
            <div class="led {c.cls}" class:on={d.led(c.i)} id="led{c.i}" title={c.title}></div>
          </div>
          {#if c.gapAfter}<div class="led-group-divider"></div>{/if}
        {/each}
      </div>
      <div class="dip-container" id="dipContainer">
        {#each LED_CELLS as c (c.i)}
          <div class="dip-cell">
            <div class="dip-switch" class:on={d.dip(c.i)} id="dip{c.i}" onclick={() => toggleDip(c.i)}
              title="DIP[{c.i}] (SW{c.i}) — Click to toggle ON/OFF">
              <div class="dip-rect-top"></div>
              <div class="dip-rect-bottom"></div>
            </div>
            <div class="dip-sublabel">SW{c.i}</div>
          </div>
          {#if c.gapAfter}<div class="led-group-divider" style="visibility:hidden"></div>{/if}
        {/each}
      </div>
      <div style="font-size:10px;color:#585b70;margin-top:2px;">DIP Switches <span
          class="periph-addr">0xFFFF0064 RO (SW15..SW0)</span></div>
    </div>
  </div>

  <!-- Push Buttons & 7-Segment Display Section -->
  <div class="periph-pair">
    <div class="periph-section" data-periph="pb" class:periph-folded={d.folded('pb')}>
      <div class="periph-title" onclick={() => togglePeriphFold('pb')}
        title="Push Buttons: Read at 0xFFFF0068 RO [Bit 0: BTNL, Bit 1: BTNC, Bit 2: BTNR]. Click to toggle, or hold J, K or L.">
        Push Buttons <span class="periph-addr">0xFFFF0068 RO</span>
      </div>
      <div id="pbContainer">
        <div class="btn-row">
          {#each PB_BUTTONS as b (b.bit)}
            <div class="pb-btn-wrap"><div class="pb-btn" class:pressed={d.pressed(b.bit)} id={b.id} title={b.title}
              onclick={() => pbToggle(b.bit)}>{b.name}</div></div>
          {/each}
        </div>
      </div>
      <div style="margin-top:8px;font-size:10px;color:#585b70;">
        BTNL | BTNC | BTNR — click to toggle, or hold J K L
      </div>
    </div>
    <div class="periph-section" data-periph="sevseg" class:periph-folded={d.folded('sevseg')}>
      <div class="periph-title" onclick={() => togglePeriphFold('sevseg')} title="7-Segment Display: 8-digit 32-bit hex display at 0xFFFF0080 WO.">
        7-Segment Display <span class="periph-addr">0xFFFF0080 WO</span>
      </div>
      <div class="sevseg-container" id="sevsegContainer">
        {#each d.sevseg as bits}
          <svg class="sevseg-digit" viewBox="0 0 22 40">
            {#each SEGMENT_PATHS as path, i}
              <path d={path} class="sevseg-segment" class:lit={bits[i]} data-seg={i}></path>
            {/each}
          </svg>
        {/each}
      </div>
    </div>
  </div>

  <!-- Cycle Counter Standalone Peripheral Section -->
  <div class="periph-section" id="cycleSection" style="padding:7px 10px;">
    <div class="periph-title"
      style="display:flex;justify-content:space-between;align-items:center;gap:8px;margin-bottom:0;"
      title="Cycle Counter: 32-bit elapsed CPU clock cycles since system reset (0xFFFF00A0 RO).">
      <span>Cycle Counter &nbsp;<span class="periph-addr" style="margin-left:4px;">0xFFFF00A0 RO</span></span>
      <div style="display:flex;align-items:center;gap:8px;">
        <span style="font-size:11px;color:#a6adc8;">Total Cycles: <span id="badgeCycleCount"
            style="color:#89b4fa;font-family:'Consolas','Courier New',monospace;font-weight:bold;font-size:12px;background:#181825;padding:2px 8px;border-radius:4px;border:1px solid #313244;">{d.cycles}</span></span>
      </div>
    </div>
  </div>

  <!-- UART Serial Console Section -->
  <div class="periph-section" id="uartSection" data-periph="uart" class:periph-folded={d.folded('uart')}>
    <div class="periph-title" onclick={() => togglePeriphFold('uart')} style="display:flex;justify-content:space-between;align-items:center;gap:8px;"
      title="UART 16550 Serial Console (115200 8N1): 0xFFFF0000 RX_VALID (RO), 0xFFFF0004 RX (RO), 0xFFFF0008 TX_READY (RO), 0xFFFF000C TX (WO).">
      <span>UART Serial Console (115200 8N1) &nbsp;<span class="periph-addr"
          style="margin-left:4px;">0xFFFF0000–0xFFFF000C</span></span>
      <span style="font-size:10px;color:#a6adc8;" id="uartStatusBadges">
        RX_VALID: <span id="badgeRxValid" style="font-weight:bold;" style:color={d.rxValid ? '#a6e3a1' : '#f9e2af'}>{d.rxValid ? '1' : '0'}</span> &nbsp;·&nbsp;
        TX_READY: <span id="badgeTxReady" style="color:#a6e3a1;font-weight:bold;">1</span>
      </span>
    </div>
    <div class="uart-terminal" id="uartTerminal" title="Terminal Output (0xFFFF000C WO)">{d.terminal}</div>
    <div class="uart-controls">
      <select id="uartInputMode" title="Input and output mode" style="flex:0 0 auto;"
        value={d.hexMode ? 'hex' : 'ascii'} onchange={e => setUartInputMode(e.currentTarget.value)}>
        <option value="ascii">ASCII</option>
        <option value="hex">Hex</option>
      </select>
      <input type="text" id="uartInputText"
        placeholder={d.hexMode ? 'Comma-separated hex bytes — 0x48, 0x69, 0x0D, ...' : 'ASCII text incl. extended — \\r, \\n, ...'}
        style="flex:1;min-width:0;"
        autocomplete="off" autocapitalize="off" spellcheck="false" enterkeyhint="send"
        onkeydown={e => { if (e.key === 'Enter') { e.preventDefault(); sendUartInput(); } }}>
      <button id="uartSendBtn" onclick={sendUartInput} class="primary"
        style:background={d.sending ? '#f38ba8' : null}>{d.sending ? 'Cancel' : 'Send'}</button>
      <button id="uartClearBtn" onclick={clearUartTx} disabled={!d.canClear} class:inactive={!d.canClear}
        title={d.canClear ? 'Clear Terminal display output' : 'Terminal output is already empty'}>Clear</button>
    </div>
    <div class="uart-controls"
      style="margin-top:4px;display:flex;align-items:center;gap:6px 10px;font-size:11px;flex-wrap:wrap;">
      <div style="display:inline-flex;align-items:center;gap:6px;">
        <label style="font-size:11px;color:#cba6f7;font-weight:600;white-space:nowrap;"
          for="uartSendMode"
          title="How fast the characters arrive. The board holds one byte at a time, so anything the program does not read before the next arrives is lost.">Arrival</label>
        <select id="uartSendMode" value={d.sendMode} onchange={e => setUartSendMode(e.currentTarget.value)}
          style="--sel-h:24px;font-size:11px;flex:0 0 auto;"
          title="Sets the gap between arriving characters, shown in the box beside this. Paste and Typed both keep to that gap whether or not your program has read the previous byte, so a slow polling loop loses characters. Paste uses one character time at 115200 baud at the clock set in Settings. Typed uses a much larger gap, as if someone were typing it in. Forgiving ignores the gap and holds each character until your program has read the one before, so nothing is ever dropped. The board cannot do that.">
          <option value="paste">Paste (baud rate)</option>
          <option value="typed">Typed (slow)</option>
          <option value="forgiving">Forgiving (never drops)</option>
        </select>
        <span style="display:inline-flex;align-items:center;gap:4px;white-space:nowrap;">
          <input type="number" id="uartCharInstr" value={d.charInstr} min="1" max="999999"
            disabled={!d.charInstrSet} style:opacity={d.charInstrSet ? null : '0.5'}
            style="width:56px;height:24px;padding:2px 4px;font-size:11px;box-sizing:border-box;border-radius:3px;border:1px solid #45475a;background:#313244;color:#cdd6f4;text-align:center;flex:0 0 auto;"
            onchange={e => setUartCharInstr(e.currentTarget.value)}
            title="Clock cycles between characters. In Paste mode it is one character at 115200 baud at the clock set in Settings (270 at CLK_DIV_BITS 5); in Typed mode, set it here.">
          <span style="color:#a6adc8;" id="uartCharUnit"
            title="Clock cycles between characters">cycles/char</span>
        </span>
      </div>
      <div class="uart-queue-info" id="uartQueueInfo"
        style="margin:0;display:inline-flex;align-items:center;gap:4px;flex-wrap:wrap;">
        <span style="color:#6c7086;">·</span>
        <span>RX Queue: <span id="uartQueueCount" style="color:#cdd6f4;">{d.queueCount}</span> <span
            id="uartQueuePreview" style="color:#6c7086;">{d.queuePreview}</span></span>
        <span id="uartAutoSendStatus" style="color:#a6e3a1;font-weight:600;">{d.status}</span>
      </div>
    </div>
  </div>

  <!-- 3-Axis Accelerometer & Temp Sensor Section -->
  <div class="periph-section" id="accelSection" data-periph="accel" class:periph-folded={d.folded('accel')}>
    <div class="periph-title" onclick={() => togglePeriphFold('accel')}
      style="display:flex;justify-content:space-between;align-items:center;gap:8px;margin-bottom:4px;"
      title="3-Axis Accelerometer &amp; Temp: 0xFFFF0040 ACCEL_DATA RO ([31:24] Temp, [23:16] Z, [15:8] Y, [7:0] X), 0xFFFF0044 ACCEL_DREADY RO (Bit 0). Hold X/Y/Z/T, then , / . to adjust that axis.">
      <span>3-Axis Accelerometer &amp; Temp &nbsp;<span class="periph-addr"
          style="margin-left:4px;">0xFFFF0040–0xFFFF0044</span></span>
      <span style="font-size:10px;color:#a6adc8;">
        DREADY: <span id="badgeAccelDready" style="color:#a6e3a1;font-weight:bold;">{d.accel.dready ? '1' : '0'}</span>
      </span>
    </div>
    <div style="display:flex;flex-direction:column;gap:5px;margin-top:4px;font-size:11px;">
      <div style="display:flex;align-items:center;gap:8px;">
        <span style="width:50px;color:#89b4fa;font-weight:bold;">X Axis:</span>
        <input type="range" id="accelXSlider" min="-128" max="127" value={d.accel.x}
          title="Hold X, then , / . to decrease/increase"
          style="flex:1;accent-color:#89b4fa;cursor:pointer;" oninput={updateAccelValues}>
        <span id="accelXVal" style="width:130px;font-family:monospace;color:#cdd6f4;">{d.accelX}</span>
      </div>
      <div style="display:flex;align-items:center;gap:8px;">
        <span style="width:50px;color:#a6e3a1;font-weight:bold;">Y Axis:</span>
        <input type="range" id="accelYSlider" min="-128" max="127" value={d.accel.y}
          title="Hold Y, then , / . to decrease/increase"
          style="flex:1;accent-color:#a6e3a1;cursor:pointer;" oninput={updateAccelValues}>
        <span id="accelYVal" style="width:130px;font-family:monospace;color:#cdd6f4;">{d.accelY}</span>
      </div>
      <div style="display:flex;align-items:center;gap:8px;">
        <span style="width:50px;color:#fab387;font-weight:bold;">Z Axis:</span>
        <input type="range" id="accelZSlider" min="-128" max="127" value={d.accel.z}
          title="Hold Z, then , / . to decrease/increase"
          style="flex:1;accent-color:#fab387;cursor:pointer;" oninput={updateAccelValues}>
        <span id="accelZVal" style="width:130px;font-family:monospace;color:#cdd6f4;">{d.accelZ}</span>
      </div>
      <div style="display:flex;align-items:center;gap:8px;margin-top:2px;">
        <span style="width:50px;color:#f38ba8;font-weight:bold;">Temp:</span>
        <input type="range" id="accelTempSlider" min="-40" max="85" value={d.accel.temp}
          title="Hold T, then , / . to decrease/increase"
          style="flex:1;accent-color:#f38ba8;cursor:pointer;" oninput={updateAccelValues}>
        <span id="accelTempVal" style="width:130px;font-family:monospace;color:#cdd6f4;">{d.accelTemp}</span>
      </div>
      <div style="display:flex;gap:6px;margin-top:4px;font-size:10px;flex-wrap:wrap;">
        <button onclick={() => setAccelPreset('flat')} style="padding:2px 6px;font-size:10px;">Flat (Z=+1g)</button>
        <button onclick={() => setAccelPreset('tiltX')} id="btnTiltX" style="padding:2px 6px;font-size:10px;"
          title="Toggle Tilt X (-1g / +1g)">Tilt X (±1g)</button>
        <button onclick={() => setAccelPreset('tiltY')} id="btnTiltY" style="padding:2px 6px;font-size:10px;"
          title="Toggle Tilt Y (-1g / +1g)">Tilt Y (±1g)</button>
        <button onclick={() => setAccelPreset('shake')} style="padding:2px 6px;font-size:10px;">Shake (±2g)</button>
        <button onclick={() => setAccelPreset('zero')} style="padding:2px 6px;font-size:10px;">Zero All</button>
      </div>
      <div style="margin-top:4px;font-size:10px;color:#585b70;">
        X | Y | Z | T — hold, then , . to adjust
      </div>
    </div>
  </div>

  <!-- OLED 96x64 Pixel Display Section (Absolute Bottom) -->
  <div class="periph-section" id="oledSection" data-periph="oled" class:periph-folded={d.folded('oled')}>
    <div class="periph-title" onclick={() => togglePeriphFold('oled')}
      style="display:flex;justify-content:space-between;align-items:center;gap:8px;margin-bottom:4px;"
      title="OLED 96x64 Display: 0xFFFF0020 OLED_COL WO (0-95), 0xFFFF0024 OLED_ROW WO (0-63), 0xFFFF0028 OLED_DATA WO, 0xFFFF002C OLED_CTRL WO, 0xFFFF0030 OLED_STATUS RO (bit 0 = swap pending).">
      <span>OLED 96x64 Pixel Display &nbsp;<span class="periph-addr"
          style="margin-left:4px;">0xFFFF0020–0xFFFF0030</span></span>
      <span style="font-size:10px;color:#a6adc8;margin-left:auto;">
        SWAP PENDING: <span id="badgeOledSwap" style="color:#a6e3a1;font-weight:bold;">0</span>
      </span>
      <button onclick={e => { clearOledDisplay(); e.stopPropagation(); }} title="Clear OLED Frame Buffer"
        style="font-size:10px;padding:2px 8px;">Clear Display</button>
    </div>
    <!-- The register read-out sits beside the display when there is room
         for it and drops underneath when the panel is narrow (five-panel
         layouts), rather than being squeezed past the panel edge. -->
    <div style="display:flex;flex-wrap:wrap;gap:12px;align-items:flex-start;margin-top:4px;">
      <div
        style="background:#09090d;border:2px solid #313244;border-radius:6px;padding:4px;display:inline-block;box-shadow:0 0 10px rgba(0,0,0,0.5);">
        <!-- Drawn by updateOledCanvas() in peripherals.ts. -->
        <canvas id="oledCanvas" width="96" height="64"
          style="width:192px;height:128px;display:block;image-rendering:pixelated;background:#000;border-radius:2px;"></canvas>
      </div>
      <div style="font-size:11px;color:#a6adc8;line-height:1.5;flex:1 1 150px;min-width:150px;">
        <div><strong>OLED_COL:</strong> <span id="oledColVal"
            style="color:#f9e2af;font-family:monospace;font-weight:bold;">{d.oledCol}</span> (0–95)</div>
        <div><strong>OLED_ROW:</strong> <span id="oledRowVal"
            style="color:#f9e2af;font-family:monospace;font-weight:bold;">{d.oledRow}</span> (0–63)</div>
        <div><strong>OLED_CTRL:</strong> <span id="oledCtrlVal"
            style="color:#89b4fa;font-family:monospace;font-weight:bold;">{d.oledCtrl}</span></div>
        <div style="font-size:10px;color:#6c7086;margin-top:3px;" id="oledModeDesc">{d.oledMode}</div>
        <div style="font-size:10px;color:#6c7086;" id="oledBufDesc">{d.oledBuf}</div>
      </div>
    </div>
  </div>
</div>
