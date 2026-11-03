// doomgeneric platform layer for a WebAssembly (wasm32-wasi) build that is
// driven from JavaScript. JS owns the clock, the input queue and the display:
// it calls tx_init() once, then tx_tick() on a timer, and reads the 32-bit
// BGRA framebuffer (DG_ScreenBuffer) straight out of linear memory.
#include <stdint.h>
#include <stdlib.h>
#include "doomgeneric.h"

#define EXPORT(name) __attribute__((export_name(name)))
#define IMPORT(name) __attribute__((import_module("textjs"), import_name(name)))

IMPORT("ticks_ms") uint32_t js_ticks_ms(void);
IMPORT("frame") void js_frame(void);

#define KEYQ 64
static uint16_t keyq[KEYQ];
static unsigned keyq_w, keyq_r;

EXPORT("tx_push_key") void tx_push_key(int pressed, int doomkey) {
    keyq[keyq_w] = (uint16_t)((pressed ? 0x100 : 0) | (doomkey & 0xff));
    keyq_w = (keyq_w + 1) % KEYQ;
}

static char *argv_store[8];
EXPORT("tx_init") void tx_init(int skill_warp) {
    int argc = 0;
    argv_store[argc++] = "doom";
    argv_store[argc++] = "-iwad";
    argv_store[argc++] = "doom1.wad";
    (void)skill_warp;
    doomgeneric_Create(argc, argv_store);
}
EXPORT("tx_tick") void tx_tick(void) { doomgeneric_Tick(); }
EXPORT("tx_framebuffer") pixel_t *tx_framebuffer(void) { return DG_ScreenBuffer; }
EXPORT("tx_width") int tx_width(void) { return DOOMGENERIC_RESX; }
EXPORT("tx_height") int tx_height(void) { return DOOMGENERIC_RESY; }

void DG_Init(void) {}
void DG_DrawFrame(void) { js_frame(); }
void DG_SleepMs(uint32_t ms) { (void)ms; }  // JS drives timing; never block
uint32_t DG_GetTicksMs(void) { return js_ticks_ms(); }
int DG_GetKey(int *pressed, unsigned char *key) {
    if (keyq_r == keyq_w) return 0;
    uint16_t k = keyq[keyq_r];
    keyq_r = (keyq_r + 1) % KEYQ;
    *pressed = k >> 8;
    *key = k & 0xff;
    return 1;
}
void DG_SetWindowTitle(const char *title) { (void)title; }

// wasi-libc wants a main() for the default crt1 command model; we link as a
// reactor instead (-mexec-model=reactor), so this is never called.

// i_system.c calls system() to show a GUI error dialog on some hosts.
int system(const char *cmd) { (void)cmd; return -1; }
