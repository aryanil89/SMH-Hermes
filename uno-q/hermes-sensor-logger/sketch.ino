#include <Arduino_Modulino.h>
#include <Arduino_RouterBridge.h>
#include <ArduinoGraphics.h>
#include <Arduino_LED_Matrix.h>

ModulinoButtons buttons;
ModulinoDistance distance;
ModulinoThermo thermo;
Arduino_LED_Matrix matrix;

const char BUTTON_LETTERS[3] = {'A', 'B', 'C'};
const char* BUTTON_EVENTS[3] = {"door_open", "light_on", "leak_detected"};
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

void readSensors() {
  currentTempC = thermo.getTemperature();
  currentHumidityPct = thermo.getHumidity();
  if (distance.available()) {
    currentDistanceMm = distance.get();
  }
}

void showLetter(char c) {
  matrix.beginText(4, 0, 255, 255, 255);
  matrix.print(c);
  matrix.endText(NO_SCROLL);
}

void showReadout() {
  char buf[24];
  if (showTempNext) {
    snprintf(buf, sizeof(buf), "%.1fC", currentTempC);
  } else {
    if (currentDistanceMm < 0) {
      snprintf(buf, sizeof(buf), "D:--");
    } else {
      snprintf(buf, sizeof(buf), "%.0fmm", currentDistanceMm);
    }
  }
  showTempNext = !showTempNext;

  matrix.beginText(0, 0, 0, 255, 0);
  matrix.print(buf);
  matrix.endText(SCROLL_LEFT); // blocks for the scroll duration -- see sketch/README for why
}

void setup() {
  Bridge.begin();
  Modulino.begin(Wire1);

  buttons.begin();
  distance.begin();
  thermo.begin();

  matrix.begin();
  matrix.textFont(Font_5x7);
  matrix.textScrollSpeed(60);

  readSensors();
}

void loop() {
  unsigned long now = millis();
  if (now - lastSensorRead >= SENSOR_READ_INTERVAL) {
    lastSensorRead = now;
    readSensors();
  }

  if (now - lastTick >= TICK_INTERVAL) {
    lastTick = now;
    // Same argument shape as the button channel; the event name routes it to
    // the sensor_tick callback in main.py.
    Bridge.notify("sensor_tick", String("sensor_tick"), currentDistanceMm, currentTempC, currentHumidityPct);
  }

  buttons.update();
  for (int i = 0; i < 3; i++) {
    bool pressed = buttons.isPressed(i);
    if (pressed && !wasPressed[i]) {
      // Rising edge only -- one log entry per press, not one per polling tick.
      Bridge.notify("button_pressed", String(BUTTON_EVENTS[i]), currentDistanceMm, currentTempC, currentHumidityPct);
      showLetter(BUTTON_LETTERS[i]);
      delay(800);
    }
    wasPressed[i] = pressed;
  }

  showReadout();
}
