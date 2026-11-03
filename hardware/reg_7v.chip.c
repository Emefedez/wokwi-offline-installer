#include "wokwi-api.h"
#include <stdio.h>
#include <stdlib.h>

// 7V Voltage Regulator (Step-down Buck Converter):
// Takes 12V-24V DC input and steps down to 7.0V (6.0-7.4V range) to power YB-P20M servos,
// while sharing common GND with ESP32-S3 so 3.3V GPIO PWM signals control the servos safely.

typedef struct {
  pin_t vin_pos;
  pin_t vin_neg;
  pin_t vout_pos;
  pin_t vout_neg;
  pin_t en;
  uint32_t vin_attr;
  uint32_t vout_attr;
} chip_state_t;

static void on_en_change(void *user_data, pin_t pin, uint32_t value) {
  chip_state_t *chip = (chip_state_t *)user_data;
  pin_write(chip->vout_pos, value == HIGH ? HIGH : LOW);
}

void chip_init(void) {
  chip_state_t *chip = calloc(1, sizeof(chip_state_t));
  chip->vin_pos = pin_init("VIN_POS", INPUT_PULLUP);
  chip->vin_neg = pin_init("VIN_NEG", INPUT_PULLDOWN);
  chip->vout_pos = pin_init("VOUT_POS", OUTPUT_HIGH);
  chip->vout_neg = pin_init("VOUT_NEG", OUTPUT_LOW);
  chip->en = pin_init("EN", INPUT_PULLUP);
  chip->vin_attr = attr_init("vinVolts", 12);
  chip->vout_attr = attr_init("voutMv", 7000);

  const pin_watch_config_t watch_cfg = {
    .edge = BOTH,
    .pin_change = on_en_change,
    .user_data = chip,
  };
  pin_watch(chip->en, &watch_cfg);
  printf("[7V-Regulator] Buck 12-24V IN -> 7.0V OUT Servo Power Rail initialized\n");
}
