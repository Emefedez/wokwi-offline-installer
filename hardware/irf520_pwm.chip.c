#include "wokwi-api.h"
#include <stdio.h>
#include <stdlib.h>

// IRF520 PWM Specs:
// Vds max: 100 V, Vgs max: +-20 V
// Id continuous: 9.2 A (Tc=25C) / 6.5 A (Tc=100C), Idm pulsed: 37 A, Pd: 60 W

typedef struct {
  pin_t sig;
  pin_t vcc;
  pin_t gnd;
  pin_t vin;
  pin_t vplus;
  pin_t vminus;
  uint32_t vds_attr;
  uint32_t id_attr;
} chip_state_t;

static void on_sig_change(void *user_data, pin_t pin, uint32_t value) {
  chip_state_t *chip = (chip_state_t *)user_data;
  pin_write(chip->vminus, value ? LOW : HIGH);
  pin_write(chip->vplus, HIGH);
}

void chip_init(void) {
  chip_state_t *chip = calloc(1, sizeof(chip_state_t));
  chip->sig = pin_init("SIG", INPUT_PULLDOWN);
  chip->vcc = pin_init("VCC", INPUT_PULLUP);
  chip->gnd = pin_init("GND", INPUT_PULLDOWN);
  chip->vin = pin_init("VIN", INPUT_PULLUP);
  chip->vplus = pin_init("VPLUS", OUTPUT_HIGH);
  chip->vminus = pin_init("VMINUS", OUTPUT_HIGH);
  chip->vds_attr = attr_init("vdsVolts", 12);
  chip->id_attr = attr_init("loadCurrentMa", 1000);

  const pin_watch_config_t watch_cfg = {
    .edge = BOTH,
    .pin_change = on_sig_change,
    .user_data = chip,
  };
  pin_watch(chip->sig, &watch_cfg);
  printf("[IRF520-PWM] MOSFET Driver initialized (Vds<=100V, Id<=9.2A, Pd<=60W)\n");
}
