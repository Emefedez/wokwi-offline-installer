#include "wokwi-api.h"
#include <stdio.h>
#include <stdlib.h>

// CJMCU-230 SN65HVD230 Specs:
// Vcc: -0.3V to 6V (Typ 3.3V)
// CANH / CANL: -4V to 6V
// VI (D or R): -0.5V to (VCC + 0.5)V
// Receiver output current IO: -11mA to 11mA

typedef struct {
  pin_t d;
  pin_t gnd;
  pin_t vcc;
  pin_t r;
  pin_t vref;
  pin_t canl;
  pin_t canh;
  pin_t rs;
  uint32_t vcc_attr;
  uint32_t loopback_attr;
} chip_state_t;

static void on_tx_change(void *user_data, pin_t pin, uint32_t value) {
  chip_state_t *chip = (chip_state_t *)user_data;
  if (pin_read(chip->rs) == HIGH) {
    // Standby mode when RS is HIGH
    return;
  }
  // Dominant when D == LOW
  if (value == LOW) {
    pin_write(chip->canh, HIGH);
    pin_write(chip->canl, LOW);
  } else {
    pin_write(chip->canh, LOW);
    pin_write(chip->canl, HIGH);
  }
  if (attr_read(chip->loopback_attr)) {
    pin_write(chip->r, value);
  }
}

void chip_init(void) {
  chip_state_t *chip = calloc(1, sizeof(chip_state_t));
  chip->d = pin_init("D", INPUT_PULLUP);
  chip->gnd = pin_init("GND", INPUT_PULLDOWN);
  chip->vcc = pin_init("VCC", INPUT_PULLUP);
  chip->r = pin_init("R", OUTPUT_HIGH);
  chip->vref = pin_init("VREF", OUTPUT_HIGH);
  chip->canl = pin_init("CANL", OUTPUT_HIGH);
  chip->canh = pin_init("CANH", OUTPUT_LOW);
  chip->rs = pin_init("RS", INPUT_PULLDOWN);
  chip->vcc_attr = attr_init("vccMv", 3300);
  chip->loopback_attr = attr_init("loopback", 1);

  const pin_watch_config_t watch_cfg = {
    .edge = BOTH,
    .pin_change = on_tx_change,
    .user_data = chip,
  };
  pin_watch(chip->d, &watch_cfg);
  printf("[CJMCU-230] SN65HVD230 CAN Transceiver initialized (Vcc <=6V, IO +-11mA)\n");
}
