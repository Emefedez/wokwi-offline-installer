#include "wokwi-api.h"

extern __attribute__((import_module("env"), import_name("debugPrint"))) void debug_print(const char *msg);

typedef struct {
  pin_t canh;
  pin_t canl;
  pin_t cantx;
  pin_t canrx;
  pin_t trig;
  pin_t vcc;
  pin_t gnd;

  uint32_t can_id_attr;
  uint32_t cmd_type_attr;
  uint32_t steering_attr;
  uint32_t throttle_attr;
  uint32_t send_seq_attr;
  uint32_t auto_periodic_attr;

  uint32_t last_can_id;
  uint32_t last_cmd_type;
  uint32_t last_steering;
  uint32_t last_throttle;
  uint32_t last_send_seq;

  uint32_t tx_count;
  uint32_t rx_count;
  uint32_t bus_phase;

  buffer_t fb;
  uint32_t fb_w;
  uint32_t fb_h;

  timer_t poll_timer;
  timer_t periodic_timer;
  timer_t pulse_timer;
} can_term_state_t;

static can_term_state_t g_state;
static uint8_t g_pixels[128 * 48 * 4];

static void append_str(char **p, const char *s) {
  while (*s) {
    *(*p)++ = *s++;
  }
}

static void append_hex(char **p, uint32_t val, int digits) {
  const char *hex = "0123456789ABCDEF";
  for (int i = digits - 1; i >= 0; i--) {
    *(*p)++ = hex[(val >> (i * 4)) & 0xF];
  }
}

static void append_u32(char **p, uint32_t val) {
  char tmp[12];
  int i = 0;
  if (val == 0) {
    *(*p)++ = '0';
    return;
  }
  while (val > 0 && i < 11) {
    tmp[i++] = (char)('0' + (val % 10));
    val /= 10;
  }
  while (i > 0) {
    *(*p)++ = tmp[--i];
  }
}

static void render_display(can_term_state_t *st, bool tx_active, bool rx_active) {
  if (st->fb_w != 128 || st->fb_h != 48) return;
  uint32_t steer = attr_read(st->steering_attr);
  uint32_t throt = attr_read(st->throttle_attr);
  if (steer > 180) steer = 180;
  if (throt > 100) throt = 100;

  uint32_t steer_bar = (steer * 112) / 180;
  uint32_t throt_bar = (throt * 112) / 100;

  for (uint32_t y = 0; y < 48; y++) {
    for (uint32_t x = 0; x < 128; x++) {
      uint32_t idx = (y * 128 + x) * 4;
      // Dark terminal background (#0c1424)
      uint8_t r = 12, g = 20, b = 36;

      // Border
      if (x == 0 || x == 127 || y == 0 || y == 47) {
        r = 56; g = 189; b = 248;
      }
      // Top header status bar (y: 3..11)
      else if (y >= 3 && y <= 11) {
        if (x >= 4 && x <= 58) {
          // TX indicator LED bar
          r = tx_active ? 34 : 16;
          g = tx_active ? 197 : 75;
          b = tx_active ? 94 : 40;
        } else if (x >= 68 && x <= 123) {
          // RX ACK indicator LED bar
          r = rx_active ? 56 : 20;
          g = rx_active ? 189 : 60;
          b = rx_active ? 248 : 90;
        }
      }
      // Steering Servo gauge bar (y: 18..26)
      else if (y >= 18 && y <= 26 && x >= 8 && x < 120) {
        if (x - 8 <= steer_bar) {
          r = 168; g = 85; b = 247; // Purple steering bar
        } else {
          r = 30; g = 41; b = 59;
        }
      }
      // Throttle PWM gauge bar (y: 32..40)
      else if (y >= 32 && y <= 40 && x >= 8 && x < 120) {
        if (x - 8 <= throt_bar) {
          r = 34; g = 197; b = 94; // Green throttle bar
        } else {
          r = 30; g = 41; b = 59;
        }
      }

      g_pixels[idx + 0] = r;
      g_pixels[idx + 1] = g;
      g_pixels[idx + 2] = b;
      g_pixels[idx + 3] = 255;
    }
  }
  buffer_write(st->fb, 0, g_pixels, sizeof(g_pixels));
}

static void transmit_can_frame(can_term_state_t *st, const char *reason) {
  uint32_t can_id = attr_read(st->can_id_attr);
  uint32_t cmd = attr_read(st->cmd_type_attr);
  uint32_t steer = attr_read(st->steering_attr);
  uint32_t throt = attr_read(st->throttle_attr);
  st->tx_count++;

  uint8_t d0 = (uint8_t)(cmd & 0xFF);
  uint8_t d1 = (uint8_t)(steer & 0xFF);
  uint8_t d2 = (uint8_t)(throt & 0xFF);
  uint8_t d3 = (cmd == 2) ? 0xFF : 0x01; // Brake flag or Enable flag
  uint8_t d4 = 0xCA;
  uint8_t d5 = 0x4E;
  uint8_t d6 = (uint8_t)((st->tx_count >> 8) & 0xFF);
  uint8_t d7 = (uint8_t)(st->tx_count & 0xFF);

  char buf[220];
  char *p = buf;
  append_str(&p, "[CAN-TERMINAL TX #");
  append_u32(&p, st->tx_count);
  append_str(&p, " (");
  append_str(&p, reason);
  append_str(&p, ")] ID=0x");
  append_hex(&p, can_id, 3);
  append_str(&p, " DLC=8 DATA=[");
  append_hex(&p, d0, 2); *p++ = ' ';
  append_hex(&p, d1, 2); *p++ = ' ';
  append_hex(&p, d2, 2); *p++ = ' ';
  append_hex(&p, d3, 2); *p++ = ' ';
  append_hex(&p, d4, 2); *p++ = ' ';
  append_hex(&p, d5, 2); *p++ = ' ';
  append_hex(&p, d6, 2); *p++ = ' ';
  append_hex(&p, d7, 2);
  append_str(&p, "] -> Steer=");
  append_u32(&p, steer);
  append_str(&p, "deg Throttle=");
  append_u32(&p, throt);
  append_str(&p, "%");
  *p = '\0';
  debug_print(buf);

  // Drive dominant CAN bus state (CANH=HIGH, CANL=LOW, CANTX=LOW)
  st->bus_phase = 1;
  pin_write(st->canh, HIGH);
  pin_write(st->canl, LOW);
  pin_write(st->cantx, LOW);
  render_display(st, true, false);

  // Schedule bus release & ACK completion in 15ms
  timer_start(st->pulse_timer, 15000, false);
}

static void on_pulse_done(void *user_data) {
  can_term_state_t *st = (can_term_state_t *)user_data;
  if (st->bus_phase == 1) {
    // Return bus to recessive (CANH=LOW, CANL=HIGH, CANTX=HIGH)
    st->bus_phase = 0;
    pin_write(st->canh, LOW);
    pin_write(st->canl, HIGH);
    pin_write(st->cantx, HIGH);

    // Log ESP32-S3 + CJMCU-230 CAN Bus ACK response
    st->rx_count++;
    uint32_t can_id = attr_read(st->can_id_attr);
    uint32_t steer = attr_read(st->steering_attr);
    uint32_t throt = attr_read(st->throttle_attr);

    char buf[220];
    char *p = buf;
    append_str(&p, "[CAN-TERMINAL RX #");
    append_u32(&p, st->rx_count);
    append_str(&p, " <- ESP32-S3 ACK] ID=0x");
    append_hex(&p, (can_id + 8) & 0x7FF, 3);
    append_str(&p, " DLC=8 DATA=[AC ");
    append_hex(&p, steer & 0xFF, 2); *p++ = ' ';
    append_hex(&p, throt & 0xFF, 2);
    append_str(&p, " 00 0C E4 00 OK] Status=OK (YB-P20M=");
    append_u32(&p, steer);
    append_str(&p, "deg, JGB37=");
    append_u32(&p, throt);
    append_str(&p, "%)");
    *p = '\0';
    debug_print(buf);

    render_display(st, false, true);
  }
}

static void on_canrx_edge(void *user_data, pin_t pin, uint32_t value) {
  can_term_state_t *st = (can_term_state_t *)user_data;
  if (value == LOW && st->bus_phase == 0) {
    st->rx_count++;
    char buf[160];
    char *p = buf;
    append_str(&p, "[CAN-TERMINAL RXHW #");
    append_u32(&p, st->rx_count);
    append_str(&p, "] Dominant frame edge detected on CANRX from ESP32-S3 TWAI controller!");
    *p = '\0';
    debug_print(buf);
    render_display(st, false, true);
  }
}

static void on_trig_edge(void *user_data, pin_t pin, uint32_t value) {
  can_term_state_t *st = (can_term_state_t *)user_data;
  if (value == LOW) {
    transmit_can_frame(st, "TRIG-BUTTON");
  }
}

static void on_poll_controls(void *user_data) {
  can_term_state_t *st = (can_term_state_t *)user_data;
  uint32_t can_id = attr_read(st->can_id_attr);
  uint32_t cmd = attr_read(st->cmd_type_attr);
  uint32_t steer = attr_read(st->steering_attr);
  uint32_t throt = attr_read(st->throttle_attr);
  uint32_t seq = attr_read(st->send_seq_attr);

  if (can_id != st->last_can_id ||
      cmd != st->last_cmd_type ||
      steer != st->last_steering ||
      throt != st->last_throttle ||
      seq != st->last_send_seq) {
    st->last_can_id = can_id;
    st->last_cmd_type = cmd;
    st->last_steering = steer;
    st->last_throttle = throt;
    st->last_send_seq = seq;
    transmit_can_frame(st, "CONTROL-CHANGE");
  }
}

static void on_periodic_tx(void *user_data) {
  can_term_state_t *st = (can_term_state_t *)user_data;
  if (attr_read(st->auto_periodic_attr)) {
    transmit_can_frame(st, "AUTO-HEARTBEAT");
  }
}

void chip_init(void) {
  can_term_state_t *st = &g_state;
  st->canh = pin_init("CANH", OUTPUT_LOW);
  st->canl = pin_init("CANL", OUTPUT_HIGH);
  st->cantx = pin_init("CANTX", OUTPUT_HIGH);
  st->canrx = pin_init("CANRX", INPUT_PULLUP);
  st->trig = pin_init("TRIG", INPUT_PULLUP);
  st->vcc = pin_init("VCC", INPUT_PULLUP);
  st->gnd = pin_init("GND", INPUT_PULLDOWN);

  st->can_id_attr = attr_init("canId", 288);       // 0x120
  st->cmd_type_attr = attr_init("cmdType", 0);     // Steer + Throttle
  st->steering_attr = attr_init("steeringDeg", 90);
  st->throttle_attr = attr_init("throttlePct", 50);
  st->send_seq_attr = attr_init("sendSeq", 0);
  st->auto_periodic_attr = attr_init("autoPeriodic", 1);

  st->last_can_id = attr_read(st->can_id_attr);
  st->last_cmd_type = attr_read(st->cmd_type_attr);
  st->last_steering = attr_read(st->steering_attr);
  st->last_throttle = attr_read(st->throttle_attr);
  st->last_send_seq = attr_read(st->send_seq_attr);

  st->fb = framebuffer_init(&st->fb_w, &st->fb_h);
  render_display(st, false, false);

  const pin_watch_config_t rx_watch = {
    .user_data = st,
    .edge = FALLING,
    .pin_change = on_canrx_edge,
  };
  pin_watch(st->canrx, &rx_watch);

  const pin_watch_config_t trig_watch = {
    .user_data = st,
    .edge = FALLING,
    .pin_change = on_trig_edge,
  };
  pin_watch(st->trig, &trig_watch);

  const timer_config_t pulse_cfg = {
    .user_data = st,
    .callback = on_pulse_done,
  };
  st->pulse_timer = timer_init(&pulse_cfg);

  const timer_config_t poll_cfg = {
    .user_data = st,
    .callback = on_poll_controls,
  };
  st->poll_timer = timer_init(&poll_cfg);
  timer_start(st->poll_timer, 150000, true); // Poll controls every 150ms

  const timer_config_t periodic_cfg = {
    .user_data = st,
    .callback = on_periodic_tx,
  };
  st->periodic_timer = timer_init(&periodic_cfg);
  timer_start(st->periodic_timer, 2000000, true); // Auto heartbeat every 2.0s

  debug_print("[CAN-TERMINAL] Simulated CAN 2.0A Bus Terminal initialized (ID=0x120, 500kbps, Connected to CJMCU-230 & ESP32-S3)");
  transmit_can_frame(st, "BOOT-TEST");
}
