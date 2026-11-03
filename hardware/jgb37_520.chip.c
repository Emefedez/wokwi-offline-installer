#include "wokwi-api.h"
#include <stdio.h>
#include <stdlib.h>

// JGB37-520 Specs:
// 12V: No-load 120 mA, Load/Stall: 400 mA (400 A in sheet table)
// 24V: No-load 50 mA, Load/Stall: 200 mA (200 A in sheet table)

typedef struct {
  pin_t m1;
  pin_t m2;
  pin_t gnd;
  pin_t c1;
  pin_t c2;
  pin_t vcc;
  uint32_t voltage_attr;
  uint32_t load_attr;
  uint8_t enc_phase;
} chip_state_t;

static void on_motor_drive(void *user_data, pin_t pin, uint32_t value) {
  chip_state_t *chip = (chip_state_t *)user_data;
  uint32_t m1_val = pin_read(chip->m1);
  uint32_t m2_val = pin_read(chip->m2);
  if (m1_val != m2_val) {
    chip->enc_phase = (chip->enc_phase + 1) & 3;
    pin_write(chip->c1, (chip->enc_phase & 1) ? HIGH : LOW);
    pin_write(chip->c2, (chip->enc_phase & 2) ? HIGH : LOW);
  }
}

void chip_init(void) {
  chip_state_t *chip = calloc(1, sizeof(chip_state_t));
  chip->m1 = pin_init("M1", INPUT);
  chip->m2 = pin_init("M2", INPUT);
  chip->gnd = pin_init("GND", INPUT_PULLDOWN);
  chip->c1 = pin_init("C1", OUTPUT_LOW);
  chip->c2 = pin_init("C2", OUTPUT_LOW);
  chip->vcc = pin_init("VCC", INPUT_PULLUP);
  chip->voltage_attr = attr_init("nominalVoltage", 12);
  chip->load_attr = attr_init("loadState", 0);

  const pin_watch_config_t watch_cfg = {
    .edge = BOTH,
    .pin_change = on_motor_drive,
    .user_data = chip,
  };
  pin_watch(chip->m1, &watch_cfg);
  pin_watch(chip->m2, &watch_cfg);
  printf("[JGB37-520] Geared Motor + Encoder initialized (12V: 120mA no-load / 24V: 50mA no-load)\n");
}
