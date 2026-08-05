#include <Arduino_Modulino.h>
#include <Arduino_RouterBridge.h>
#include <ArduinoGraphics.h>
#include <Arduino_LED_Matrix.h>

ModulinoButtons buttons;
ModulinoDistance distance;
ModulinoThermo thermo;
Arduino_LED_Matrix matrix;

const char BUTTON_LETTERS[3] = {'A', 'B', 'C'};

// Both edges are logged. The buttons model a *state* (door, light, leak), not a
// momentary trigger, so each transition is recorded in both directions and the
// log can be replayed to know what the state was at any point.
const char* BUTTON_EVENTS_PRESSED[3]  = {"door_open",   "light_on",  "leak_detected"};
const char* BUTTON_EVENTS_RELEASED[3] = {"door_closed", "light_off", "leak_cleared"};
bool wasPressed[3] = {false, false, false};

unsigned long lastSensorRead = 0;
const long SENSOR_READ_INTERVAL = 300; // ms; keeps the display "live" without hammering I2C

// Periodic telemetry channel (separate from button events): one Bridge.notify
// every TICK_INTERVAL so the laptop-side log stays fresh without anyone
// pressing a button. 10s matches the push_sensor_log.sh scp cadence. No extra
// I2C load -- readSensors() already runs every 300ms for the display; this
// only adds Bridge traffic.
unsigned long lastTick = 0;
const unsigned long TICK_INTERVAL = 10000; // ms

float currentDistanceMm = -1.0;
float currentTempC = 0.0;
float currentHumidityPct = 0.0;

// Alternates the scrolling readout between temperature and distance each pass,
// so a single pass stays short -- shorter blocking time on endText(SCROLL_LEFT)
// means buttons (checked right after each pass) get noticed sooner.
bool showTempNext = true;

// ---------------------------------------------------------------------------
// Presence detection
// ---------------------------------------------------------------------------
// The ToF module doubles as a presence sensor: anything nearer than
// PRESENCE_THRESHOLD_MM counts as "an object is here". Only the *crossings* are
// logged (object_entered / object_left) -- the same rising-edge idea the buttons
// use -- so an object parked in front of the sensor does not produce a line on
// every tick. Distances at or beyond the threshold are not reported at all.
const float PRESENCE_THRESHOLD_MM = 1000.0;

// Readings flicker either side of the threshold when an object sits right at
// it, which would otherwise emit an entered/left pair every few hundred ms.
// Require the new state to hold for this many consecutive reads (~900ms at
// SENSOR_READ_INTERVAL) before believing it. The threshold itself is not
// widened -- 1000mm means 1000mm in both directions.
const int PRESENCE_DEBOUNCE_READS = 3;

bool objectPresent = false;
int  presenceStableCount = 0;

// Whether the Distance module answered on the Qwiic bus. Tracked because
// begin() failing used to be silent: available() then never returns true, the
// logged distance sticks at -1.0 forever, and that is indistinguishable from
// "nothing within range". Retried at DISTANCE_RETRY_INTERVAL so reseating the
// connector recovers the sensor without a reflash.
bool distanceReady = false;
unsigned long lastDistanceRetry = 0;
const unsigned long DISTANCE_RETRY_INTERVAL = 5000; // ms

// A module can also answer begin() and then stop producing ranging results, in
// which case available() simply never comes true again and the retry above
// would never fire. Going this long with no sample counts as gone, which drops
// back into the begin() retry path.
unsigned long lastDistanceSample = 0;
const unsigned long DISTANCE_STALL_TIMEOUT = 10000; // ms

// ---------------------------------------------------------------------------
// Boot / connection status display
// ---------------------------------------------------------------------------
// The board reports how far along the boot-and-connect sequence it is, because
// the whole chain (WiFi -> NTP -> Tailscale/SSH) can fail at a new location and
// the matrix is the only feedback available with no laptop attached.
//
// Stage codes are shared with python/main.py -- keep the STAGE_* values there
// in sync with this enum.
enum Stage {
  STAGE_BOOT = 0, // MCU alive, Linux side not reporting yet
  STAGE_WIFI = 1, // g_stageOk: associated with an SSID
  STAGE_TIME = 2, // g_stageText: "HH:MM" once NTP has set the clock
  STAGE_SSH  = 3, // g_stageOk: laptop reachable over Tailscale with key auth
  STAGE_RUN  = 4  // normal operation -- live sensor readout
};

// Written by set_stage() on the Bridge's *own RPC thread* (Bridge.begin()
// spawns one), read by loop(). Nothing here draws: the matrix is not safe to
// touch from two threads at once, so the handler only records state and every
// render happens in loop().
volatile int  g_stage   = STAGE_BOOT;
volatile bool g_stageOk = false;
char          g_stageText[16] = {0};

// 13x8 is the whole canvas. Icons are written as text so the shape is visible
// in the source -- '#' lit, '.' dark. Each row must be exactly 13 characters.
const char* const ICON_BOOT[8] = {
  ".............",
  "..###........",
  "..###........",
  "..###........",
  "..###........",
  "..####.......",
  "..######.....",
  "..#########.."
};

// WiFi arcs (left, cols 0-6) + check mark (right, cols 8-12).
const char* const ICON_WIFI_OK[8] = {
  ".#####.......",
  "#.....#......",
  ".............",
  "..###.......#",
  ".#...#..#...#",
  ".........#.#.",
  "...#......#..",
  "............."
};

// WiFi arcs + a frowning face: eyes on row 2, mouth curving down on rows 4-5.
const char* const ICON_WIFI_BAD[8] = {
  ".#####.......",
  "#.....#......",
  ".........#.#.",
  "..###........",
  ".#...#...###.",
  "........#...#",
  "...#.........",
  "............."
};

// Full-canvas check / frown, alternated with the "SSH" label.
const char* const ICON_CHECK[8] = {
  ".............",
  ".........#...",
  "........#....",
  ".......#.....",
  "..#...#......",
  "...#.#.......",
  "....#........",
  "............."
};

const char* const ICON_FROWN[8] = {
  ".............",
  ".............",
  "...#.....#...",
  ".............",
  ".............",
  ".....###.....",
  "....#...#....",
  "............."
};

void drawIcon(const char* const rows[8]) {
  matrix.beginDraw();
  // Every pixel is written explicitly, so no separate clear step is needed.
  for (int y = 0; y < 8; y++) {
    for (int x = 0; x < 13; x++) {
      bool on = rows[y][x] == '#';
      matrix.set(x, y, on ? 255 : 0, on ? 255 : 0, on ? 255 : 0);
    }
  }
  matrix.endDraw();
}

/**
 * Called from the Linux side (python/main.py) as the boot sequence advances.
 * Runs on the Bridge RPC thread -- record state only, never draw here.
 * `text` carries the clock string for STAGE_TIME and is ignored otherwise.
 */
bool set_stage(int stage, bool ok, String text) {
  strncpy(g_stageText, text.c_str(), sizeof(g_stageText) - 1);
  g_stageText[sizeof(g_stageText) - 1] = '\0';
  g_stageOk = ok;
  g_stage = stage; // set last: loop() keys off this, so text/ok are ready first
  return true;
}

void readSensors() {
  currentTempC = thermo.getTemperature();
  currentHumidityPct = thermo.getHumidity();

  if (!distanceReady) {
    // No usable module: report "no sample" rather than a stale last reading,
    // and keep trying to bring it back.
    currentDistanceMm = -1.0;
    unsigned long now = millis();
    if (now - lastDistanceRetry >= DISTANCE_RETRY_INTERVAL) {
      lastDistanceRetry = now;
      distanceReady = distance.begin();
      if (distanceReady) {
        lastDistanceSample = now; // give it a fresh stall window, not an instant timeout
      }
    }
    return;
  }

  if (distance.available()) {
    currentDistanceMm = distance.get();
    lastDistanceSample = millis();
  } else if (millis() - lastDistanceSample >= DISTANCE_STALL_TIMEOUT) {
    distanceReady = false;
    currentDistanceMm = -1.0;
  }
}

/**
 * The distance actually written to the log: a real measurement only while an
 * object is within PRESENCE_THRESHOLD_MM, otherwise -1.0.
 *
 * -1.0 is the value the sketch already used for "no target in range", and the
 * laptop side treats it as "no sample" rather than a reading (file-source.ts
 * guards `distance_mm >= 0` before both reporting it and testing it against the
 * leak threshold). Reusing it means out-of-range readings can never be mistaken
 * for a very close object.
 */
float reportedDistanceMm() {
  if (currentDistanceMm < 0 || currentDistanceMm >= PRESENCE_THRESHOLD_MM) {
    return -1.0;
  }
  return currentDistanceMm;
}

/**
 * Emits object_entered / object_left on threshold crossings only.
 * Any read disagreeing with the committed state counts towards the debounce; a
 * read that agrees resets it, so brief flicker never reaches the log.
 */
void updatePresence() {
  bool nowPresent = (currentDistanceMm >= 0) && (currentDistanceMm < PRESENCE_THRESHOLD_MM);

  if (nowPresent == objectPresent) {
    presenceStableCount = 0;
    return;
  }

  if (++presenceStableCount < PRESENCE_DEBOUNCE_READS) {
    return;
  }

  objectPresent = nowPresent;
  presenceStableCount = 0;
  Bridge.notify("presence_event",
                String(objectPresent ? "object_entered" : "object_left"),
                reportedDistanceMm(), currentTempC, currentHumidityPct);
}

void showLetter(char c) {
  matrix.textFont(Font_5x7);
  matrix.beginText(4, 0, 255, 255, 255);
  matrix.print(c);
  matrix.endText(NO_SCROLL);
}

void showReadout() {
  char buf[24];
  if (showTempNext) {
    snprintf(buf, sizeof(buf), "%.1fC", currentTempC);
  } else {
    // Uses the same gated value as the log, so what the board shows and what it
    // records never disagree: "D:--" means nothing within PRESENCE_THRESHOLD_MM.
    float shown = reportedDistanceMm();
    if (shown < 0) {
      snprintf(buf, sizeof(buf), "D:--");
    } else {
      snprintf(buf, sizeof(buf), "%.0fmm", shown);
    }
  }
  showTempNext = !showTempNext;

  matrix.textFont(Font_5x7);
  matrix.beginText(0, 0, 0, 255, 0);
  matrix.print(buf);
  matrix.endText(SCROLL_LEFT); // blocks for the scroll duration -- see sketch/README for why
}

// Scrolls the clock string handed over by the Linux side once NTP has landed.
void showTime() {
  char buf[16];
  strncpy(buf, g_stageText, sizeof(buf) - 1);
  buf[sizeof(buf) - 1] = '\0';
  if (buf[0] == '\0') {
    delay(150);
    return; // no clock string yet -- nothing useful to show
  }
  matrix.textFont(Font_5x7);
  matrix.beginText(0, 0, 255, 255, 255);
  matrix.print(buf);
  matrix.endText(SCROLL_LEFT);
}

// "SSH" is 12px wide in Font_4x6, which fills the 13px canvas on its own, so
// the label and its verdict alternate rather than sharing the row.
void showSshStage() {
  static bool showLabel = true;
  if (showLabel) {
    matrix.textFont(Font_4x6);
    matrix.beginText(0, 1, 255, 255, 255);
    matrix.print("SSH");
    matrix.endText(NO_SCROLL);
  } else {
    drawIcon(g_stageOk ? ICON_CHECK : ICON_FROWN);
  }
  showLabel = !showLabel;
  delay(700);
}

void setup() {
  matrix.begin();
  matrix.textFont(Font_5x7);
  matrix.textScrollSpeed(60);
  drawIcon(ICON_BOOT); // MCU is alive -- shown before anything that can block

  Modulino.begin(Wire1);
  buttons.begin();
  distanceReady = distance.begin(); // retried from readSensors() if it fails
  lastDistanceSample = millis();
  thermo.begin();

  Bridge.begin();

  // The Linux router may not be up yet. Retry only the binding, never begin():
  // begin() allocates a thread stack per call and would leak one per attempt.
  for (int i = 0; i < 40 && !Bridge.provide("set_stage", set_stage); i++) {
    drawIcon(ICON_BOOT);
    delay(500);
  }

  readSensors();
}

void loop() {
  unsigned long now = millis();
  if (now - lastSensorRead >= SENSOR_READ_INTERVAL) {
    lastSensorRead = now;
    readSensors();
    updatePresence();
  }

  // Telemetry and button events sit outside the display state machine on
  // purpose: logging keeps working no matter what the matrix is showing,
  // including while the boot sequence is still stepping through its stages.
  if (now - lastTick >= TICK_INTERVAL) {
    lastTick = now;
    // Climate only -- no distance. The periodic channel exists to keep
    // temperature/humidity fresh for the laptop's staleness guard; distance is
    // reported by the presence channel on crossings instead, so a tick no
    // longer carries a measurement that would be -1.0 most of the time.
    Bridge.notify("sensor_tick", String("sensor_tick"), currentTempC, currentHumidityPct);
  }

  buttons.update();
  for (int i = 0; i < 3; i++) {
    bool pressed = buttons.isPressed(i);
    if (pressed != wasPressed[i]) {
      // Both edges -- one entry per transition, never one per polling tick.
      const char* event = pressed ? BUTTON_EVENTS_PRESSED[i] : BUTTON_EVENTS_RELEASED[i];
      Bridge.notify("button_event", String(event), reportedDistanceMm(), currentTempC, currentHumidityPct);
      if (pressed) {
        // Only the press flashes the letter: flashing again on release would
        // read as a second press, and the 800ms block would delay the next scan.
        showLetter(BUTTON_LETTERS[i]);
        delay(800);
      }
    }
    wasPressed[i] = pressed;
  }

  switch (g_stage) {
    case STAGE_WIFI:
      drawIcon(g_stageOk ? ICON_WIFI_OK : ICON_WIFI_BAD);
      delay(150); // static icon: pace the loop instead of spinning on I2C
      break;
    case STAGE_TIME:
      showTime();
      break;
    case STAGE_SSH:
      showSshStage();
      break;
    case STAGE_RUN:
      showReadout();
      break;
    case STAGE_BOOT:
    default:
      drawIcon(ICON_BOOT);
      delay(150);
      break;
  }
}
