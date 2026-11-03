#include "wokwi-api.h"
#include <stdio.h>
#include <stdlib.h>

// IP5306 Specs:
// Port input voltage VIN: -0.3 to 5.5 V
// Operating Temp: 0 ~ 70 C, Thermal Resistance: 50 C/W, ESD HBM: 4 KV

typedef struct {
  pin_t vin;
  pin_t bat;
  pin_t vout;
  pin_t gnd;
  pin_t key;
  pin_t leds[4];
  uint32_t vin_attr;
  uint32_t bat_attr;
} chip_state_t;

static void update_leds(chip_state_t *chip) {
  uint32_t pct = attr_read(chip->bat_attr);
  pin_write(chip->leds[0], pct >= 25 ? HIGH : LOW);
  pin_write(chip->leds[1], pct >= 50 ? HIGH : LOW);
  pin_write(chip->leds[2], pct >= 75 ? HIGH : LOW);
  pin_write(chip->leds[3], pct >= 95 ? HIGH : LOW);
  pin_write(chip->vout, pct > 5 ? HIGH : LOW);
}

static void on_key_change(void *user_data, pin_t pin, uint32_t value) {
  chip_state_t *chip = (chip_state_t *)user_data;
  if (value == LOW) {
    update_leds(chip);
  }
}

void chip_init(void) {
  chip_state_t *chip = calloc(1, sizeof(chip_state_t));
  chip->vin = pin_init("VIN", INPUT);
  chip->bat = pin_init("BAT", INPUT);
  chip->vout = pin_init("VOUT", OUTPUT_HIGH);
  chip->gnd = pin_init("GND", INPUT_PULLDOWN);
  chip->key = pin_init("KEY", INPUT_PULLUP);
  chip->leds[0] = pin_init("LED1", OUTPUT_HIGH);
  chip->leds[1] = pin_init("LED2", OUTPUT_HIGH);
  chip->leds[2] = pin_init("LED3", OUTPUT_HIGH);
  chip->leds[3] = pin_init("LED4", OUTPUT_LOW);
  chip->vin_attr = attr_init("vinMv", 5000);
  chip->bat_attr = attr_init("batteryPct", 80);

  update_leds(chip);
  const pin_watch_config_t watch_cfg = {
    .edge = BOTH,
    .pin_change = on_key_change,
    .user_data = chip,
  };
  pin_watch(chip->key, &watch_cfg);
  printf("[IP5306] Power Management IC initialized (VIN -0.3..5.5V, 5V Boost VOUT)\n");
}
