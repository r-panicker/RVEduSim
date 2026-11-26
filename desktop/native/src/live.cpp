// Live runs. With +LIVE the testbench calls cg3207_live_poll() at every
// rising edge. Commands from the app arrive on stdin, one per line:
//   in <code> <value>   an input change (1 DIP, 2 PB, 3 ACCEL_Data,
//                       4 ACCEL_DReady, 5 UART byte | gap << 8), or 8 to
//                       stop the waveform
//   hz <frequency>      pace the simulation to this clock; 0 for flat out
//   vcd <0|1>           flush the waveform to disk every 250 ms
//   stop                end the run at the next cycle
// +HZ=<frequency> and +LIVEVCD set the first two from the start.
// Code 6 asks the testbench to stop, 7 to flush the waveform, 9 to print
// @@C <cycle> <PC> (every 30 ms). Before cycle
// "from" the run is replaying what was recorded already, so nothing is
// paced or applied until then.
#include "Vcg3207_hdl_tb__Dpi.h"
#include "Vcg3207_hdl_tb__Syms.h"
#include "verilated.h"
#include <algorithm>
#include <chrono>
#include <cstdlib>
#include <cstdio>
#include <deque>
#include <mutex>
#include <sstream>
#include <string>
#include <thread>
#include <utility>
#ifdef _WIN32
#include <io.h>
#define cg3207_read _read
#else
#include <unistd.h>
#define cg3207_read read
#endif

namespace {
using Clock = std::chrono::steady_clock;
std::mutex mu;
std::deque<std::pair<int, int>> pending;
double hz = 0;
bool hzChanged = true;
bool stopRequested = false;
bool liveVcd = false;
bool started = false;
Clock::time_point t0, lastFlush, lastVcdFlush;
long long c0 = 0;
bool reported = false;

// Reads with read(2) rather than std::cin: a thread blocked inside stdio
// holds stdin's lock, and exit() flushing every stream would wait on it
// for ever once the testbench calls $finish.
bool nextLine(std::string& line) {
  static std::string buf;
  for (;;) {
    const std::string::size_type nl = buf.find('\n');
    if (nl != std::string::npos) {
      line = buf.substr(0, nl);
      buf.erase(0, nl + 1);
      return true;
    }
    char chunk[256];
    const int n = static_cast<int>(cg3207_read(0, chunk, sizeof chunk));
    if (n <= 0) return false;
    buf.append(chunk, n);
  }
}

void reader() {
  std::string line;
  while (nextLine(line)) {
    std::istringstream in(line);
    std::string cmd;
    in >> cmd;
    std::lock_guard<std::mutex> g(mu);
    if (cmd == "in") {
      int code = 0;
      long long v = 0;
      in >> code >> v;
      pending.emplace_back(code, static_cast<int>(static_cast<unsigned long long>(v) & 0xffffffffULL));
    } else if (cmd == "hz") {
      in >> hz;
      hzChanged = true;
    } else if (cmd == "vcd") {
      int on = 0;
      in >> on;
      liveVcd = on != 0;
    } else if (cmd == "stop") {
      stopRequested = true;
    }
  }
  std::lock_guard<std::mutex> g(mu);
  stopRequested = true;  // the app has gone
}
}  // namespace

int cg3207_live_poll(int cycle, int from, int* code, int* value) {
  if (!started) {
    started = true;
    const std::string h = Verilated::commandArgsPlusMatch("HZ=");
    if (h.size() > 4) hz = std::atof(h.c_str() + 4);
    liveVcd = !std::string(Verilated::commandArgsPlusMatch("LIVEVCD")).empty();
    std::thread(reader).detach();
  }
  // The @@C asked for on the last call has been printed by now.
  if (reported) {
    reported = false;
    std::fflush(stdout);
  }
  if (cycle < from) return 0;
  std::unique_lock<std::mutex> g(mu);
  const Clock::time_point now0 = Clock::now();
  if (hzChanged) {
    hzChanged = false;
    t0 = lastFlush = lastVcdFlush = now0;
    c0 = cycle;
  }
  if (stopRequested) {
    stopRequested = false;
    *code = 6;
    *value = 0;
    return 1;
  }
  if (!pending.empty()) {
    *code = pending.front().first;
    *value = pending.front().second;
    pending.pop_front();
    return 1;
  }
  const double h = hz;
  const bool lv = liveVcd;
  g.unlock();
  Clock::time_point now = now0;
  if (h > 0) {
    const Clock::time_point target = t0 + std::chrono::duration_cast<Clock::duration>(
      std::chrono::duration<double>(static_cast<double>(cycle - c0) / h));
    while (now < target) {
      std::fflush(stdout);
      const auto wait = std::min<Clock::duration>(target - now, std::chrono::milliseconds(10));
      std::this_thread::sleep_for(wait);
      now = Clock::now();
      std::lock_guard<std::mutex> g2(mu);
      if (stopRequested || !pending.empty() || hzChanged) return 0;  // taken on the next edge
    }
  }
  // @@C says how far the run has got and, with no architectural trace, the
  // PC, which nothing else would say.
  if (now - lastFlush > std::chrono::milliseconds(30)) {
    lastFlush = now;
    reported = true;
    *code = 9;
    *value = 0;
    return 1;
  }
  if (lv && now - lastVcdFlush > std::chrono::milliseconds(250)) {
    lastVcdFlush = now;
    *code = 7;
    *value = 0;
    return 1;
  }
  return 0;
}

// $dumpflush and $dumpoff compile to nothing in Verilator, so the testbench
// asks for them here: the dumper $dumpfile opened is flushed (1), or closed
// as $finish would close it (0). Both are members of the model's generated
// symbol table, which is one reason the app carries its own Verilator.
void cg3207_vcd(int op) {
  const VerilatedScope* s = static_cast<const VerilatedScope*>(svGetScope());
  if (!s) return;
  Vcg3207_hdl_tb__Syms* syms = static_cast<Vcg3207_hdl_tb__Syms*>(s->symsp());
  if (op == 0) {
    if (syms->__Vm_dumping) syms->_traceDumpClose();
    return;
  }
  const VerilatedLockGuard lock{syms->__Vm_dumperMutex};
  if (syms->__Vm_dumperp) syms->__Vm_dumperp->flush();
}
