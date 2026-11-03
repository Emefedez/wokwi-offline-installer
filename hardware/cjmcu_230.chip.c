#include "wokwi-api.h"

extern __attribute__((import_module("env"), import_name("debugPrint"))) void debug_print(const char *msg);

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
  uint32_t driving_bus;
} chip_state_t;

static chip_state_t g_chip;

static void on_tx_change(void *user_data, pin_t pin, uint32_t value) {
  chip_state_t *chip = (chip_state_t *)user_data;
  if (pin_read(chip->rs) == HIGH) {
    // Standby mode when RS is HIGH
    return;
  }
  // Dominant when D == LOW
  if (value == LOW) {
    chip->driving_bus = 1;
    pin_mode(chip->canh, OUTPUT_HIGH);
    pin_mode(chip->canl, OUTPUT_LOW);
    pin_write(chip->canh, HIGH);
    pin_write(chip->canl, LOW);
    debug_print("[CJMCU-230] MCU TX Dominant (D=LOW) -> Driving CANH=HIGH, CANL=LOW");
  } else {
    chip->driving_bus = 0;
    pin_mode(chip->canh, INPUT_PULLDOWN);
    pin_mode(chip->canl, INPUT_PULLUP);
  }
  if (attr_read(chip->loopback_attr)) {
    pin_write(chip->r, value);
  }
}

static void on_canh_change(void *user_data, pin_t pin, uint32_t value) {
  chip_state_t *chip = (chip_state_t *)user_data;
  if (chip->driving_bus) {
    return;
  }
  // External CAN node (e.g., Simulated CAN Bus Terminal) drove CANH
  if (value == HIGH) {
    // Dominant state on bus -> drive R LOW to ESP32-S3 CAN RX
    pin_write(chip->r, LOW);
    debug_print("[CJMCU-230] Bus Dominant (CANH=HIGH, CANL=LOW) -> Forwarding frame to ESP32-S3 R (GPIO5=LOW) & sending ACK");
  } else {
    pin_write(chip->r, HIGH);
  }
}

void chip_init(void) {
  chip_state_t *chip = &g_chip;
  chip->d = pin_init("D", INPUT_PULLUP);
  chip->gnd = pin_init("GND", INPUT_PULLDOWN);
  chip->vcc = pin_init("VCC", INPUT_PULLUP);
  chip->r = pin_init("R", OUTPUT_HIGH);
  chip->vref = pin_init("VREF", OUTPUT_HIGH);
  chip->canl = pin_init("CANL", INPUT_PULLUP);
  chip->canh = pin_init("CANH", INPUT_PULLDOWN);
  chip->rs = pin_init("RS", INPUT_PULLDOWN);
  chip->vcc_attr = attr_init("vccMv", 3300);
  chip->loopback_attr = attr_init("loopback", 1);
  chip->driving_bus = 0;

  const pin_watch_config_t watch_d = {
    .edge = BOTH,
    .pin_change = on_tx_change,
    .user_data = chip,
  };
  pin_watch(chip->d, &watch_d);

  const pin_watch_config_t watch_canh = {
    .edge = BOTH,
    .pin_change = on_canh_change,
    .user_data = chip,
  };
  pin_watch(chip->canh, &watch_canh);

  debug_print("[CJMCU-230] SN65HVD230 CAN Transceiver initialized (Vcc=3.3V, Bidirectional CANH/CANL <-> ESP32-S3 D/R ready)");
}
