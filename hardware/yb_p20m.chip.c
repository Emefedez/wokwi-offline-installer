#include "wokwi-api.h"
#include <stdio.h>
#include <stdlib.h>

// YB-P20M Specs (from tabla_piezas_voltajes_amperajes.pdf):
// Operating Voltage: 6.0 - 7.4 V
// Current-per-torque ratio: 1.317 A / (N*m) (0.0093 A/oz-in)
// Stall Current: <= 3.6 A
// Max Torque @ 7.4V: 2.7 N*m

typedef struct {
  pin_t pwm;
  pin_t vcc;
  pin_t gnd;
  pin_t fb;
  uint32_t voltage_attr;
  uint32_t torque_attr;
} chip_state_t;

static void on_pwm_change(void *user_data, pin_t pin, uint32_t value) {
  chip_state_t *chip = (chip_state_t *)user_data;
  float v = attr_read_float(chip->voltage_attr) / 1000.0f;
  float torque_nm = attr_read_float(chip->torque_attr) / 1000.0f;
  float current_a = torque_nm * 1.317f;
  if (current_a > 3.6f) current_a = 3.6f;
  if (v < 6.0f || v > 7.4f) {
    printf("[YB-P20M] WARN: Supply %.2fV outside recommended 6.0-7.4V range!\n", v);
  }
  if (value == HIGH) {
    pin_dac_write(chip->fb, (current_a / 3.6f) * 3.3f);
  }
}

void chip_init(void) {
  chip_state_t *chip = malloc(sizeof(chip_state_t));
  chip->pwm = pin_init("PWM", INPUT);
  chip->vcc = pin_init("VCC", INPUT_PULLUP);
  chip->gnd = pin_init("GND", INPUT_PULLDOWN);
  chip->fb = pin_init("FB", ANALOG);
  chip->voltage_attr = attr_init_float("voltageMv", 7400.0f);
  chip->torque_attr = attr_init_float("torqueMnm", 500.0f);

  const pin_watch_config_t watch_cfg = {
    .edge = BOTH,
    .pin_change = on_pwm_change,
    .user_data = chip,
  };
  pin_watch(chip->pwm, &watch_cfg);
  printf("[YB-P20M] Initialized (6-7.4V, <=3.6A stall, 2.7 N*m max)\n");
}
