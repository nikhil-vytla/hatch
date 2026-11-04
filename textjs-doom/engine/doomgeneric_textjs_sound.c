// Sound effects + music for the wasm build: doomgeneric calls these modules, and they
// forward raw DMX sound lumps and (MUS converted to) MIDI bytes to JS (app/lib/doom-audio.js).
// Drafted by deepseek-flash from a spec; reviewed and fixed (name clashes) by hand.
#include <stdlib.h>
#include <string.h>

#include "doomtype.h"
#include "i_sound.h"
#include "w_wad.h"
#include "z_zone.h"
#include "memio.h"
#include "mus2mid.h"
#include "m_misc.h"

__attribute__((import_module("textjs"), import_name("sfx_start")))
int sfx_start(int channel, const void *lump, int lumplen, int vol, int sep);

__attribute__((import_module("textjs"), import_name("sfx_stop")))
void sfx_stop(int channel);

__attribute__((import_module("textjs"), import_name("sfx_update")))
void sfx_update(int channel, int vol, int sep);

__attribute__((import_module("textjs"), import_name("sfx_playing")))
int sfx_playing(int channel);

__attribute__((import_module("textjs"), import_name("mus_play")))
void mus_play(const void *midi, int len, int looping);

__attribute__((import_module("textjs"), import_name("mus_stop")))
void mus_stop(void);

__attribute__((import_module("textjs"), import_name("mus_volume")))
void mus_volume(int volume);

__attribute__((import_module("textjs"), import_name("mus_pause")))
void mus_pause(int paused);

static boolean snd_use_sfx_prefix = false;

static snddevice_t sound_devices[] = {
    SNDDEVICE_SB,
    SNDDEVICE_PAS,
    SNDDEVICE_GUS,
    SNDDEVICE_WAVEBLASTER,
    SNDDEVICE_SOUNDCANVAS,
    SNDDEVICE_AWE32
};

#define NUM_SOUND_DEVICES \
    ((int)(sizeof(sound_devices) / sizeof(sound_devices[0])))

static boolean TXS_Init(boolean use_sfx_prefix)
{
    snd_use_sfx_prefix = use_sfx_prefix;
    return true;
}

static void TXS_Shutdown(void)
{
}

static int TXS_GetSfxLumpNum(sfxinfo_t *sfxinfo)
{
    const char *name;
    char lumpname[16];

    if (sfxinfo->link != NULL)
    {
        name = sfxinfo->link->name;
    }
    else
    {
        name = sfxinfo->name;
    }

    if (snd_use_sfx_prefix)
    {
        M_snprintf(lumpname, sizeof(lumpname), "ds%s", name);
    }
    else
    {
        M_snprintf(lumpname, sizeof(lumpname), "%s", name);
    }

    return W_GetNumForName(lumpname);
}

static void TXS_Update(void)
{
}

static void TXS_UpdateSoundParams(int channel, int vol, int sep)
{
    sfx_update(channel, vol, sep);
}

static int TXS_StartSound(sfxinfo_t *sfxinfo, int channel, int vol, int sep)
{
    void *lump;
    int lumplen;

    lump = W_CacheLumpNum(sfxinfo->lumpnum, PU_STATIC);
    lumplen = W_LumpLength((unsigned int)sfxinfo->lumpnum);

    return sfx_start(channel, lump, lumplen, vol, sep);
}

static void TXS_StopSound(int channel)
{
    sfx_stop(channel);
}

static boolean TXS_SoundIsPlaying(int channel)
{
    return sfx_playing(channel) != 0;
}

static void TXS_CacheSounds(sfxinfo_t *sounds, int num_sounds)
{
    (void)sounds;
    (void)num_sounds;
}

sound_module_t DG_sound_module = {
    sound_devices,
    NUM_SOUND_DEVICES,
    TXS_Init,
    TXS_Shutdown,
    TXS_GetSfxLumpNum,
    TXS_Update,
    TXS_UpdateSoundParams,
    TXS_StartSound,
    TXS_StopSound,
    TXS_SoundIsPlaying,
    TXS_CacheSounds
};

static boolean music_playing = false;

typedef struct
{
    void *data;
    int len;
} textjs_song_t;

static snddevice_t music_devices[] = {
    SNDDEVICE_SB,
    SNDDEVICE_PAS,
    SNDDEVICE_GUS,
    SNDDEVICE_WAVEBLASTER,
    SNDDEVICE_SOUNDCANVAS,
    SNDDEVICE_GENMIDI,
    SNDDEVICE_AWE32,
    SNDDEVICE_ADLIB
};

#define NUM_MUSIC_DEVICES \
    ((int)(sizeof(music_devices) / sizeof(music_devices[0])))

static boolean TXM_Init(void)
{
    return true;
}

static void TXM_Shutdown(void)
{
    mus_stop();
    music_playing = false;
}

static void TXM_SetMusicVolume(int volume)
{
    mus_volume(volume);
}

static void TXM_PauseMusic(void)
{
    mus_pause(1);
}

static void TXM_ResumeMusic(void)
{
    mus_pause(0);
}

static void *TXM_RegisterSong(void *data, int len)
{
    textjs_song_t *song;
    const unsigned char *bytes;
    MEMFILE *mus;
    MEMFILE *midi;
    void *buf;
    size_t buflen;

    if (data == NULL || len < 4)
    {
        return NULL;
    }

    bytes = (const unsigned char *)data;

    song = (textjs_song_t *)malloc(sizeof(*song));
    if (song == NULL)
    {
        return NULL;
    }

    song->data = NULL;
    song->len = 0;

    if (memcmp(bytes, "MThd", 4) == 0)
    {
        song->data = malloc((size_t)len);
        if (song->data == NULL)
        {
            free(song);
            return NULL;
        }

        memcpy(song->data, data, (size_t)len);
        song->len = len;
        return song;
    }

    if (memcmp(bytes, "MUS\x1a", 4) != 0)
    {
        free(song);
        return NULL;
    }

    mus = mem_fopen_read(data, (size_t)len);
    if (mus == NULL)
    {
        free(song);
        return NULL;
    }

    midi = mem_fopen_write();
    if (midi == NULL)
    {
        mem_fclose(mus);
        free(song);
        return NULL;
    }

    if (mus2mid(mus, midi))
    {
        mem_fclose(midi);
        mem_fclose(mus);
        free(song);
        return NULL;
    }

    buf = NULL;
    buflen = 0;
    mem_get_buf(midi, &buf, &buflen);

    song->data = malloc(buflen > 0 ? buflen : (size_t)1);
    if (song->data == NULL)
    {
        mem_fclose(midi);
        mem_fclose(mus);
        free(song);
        return NULL;
    }

    if (buflen > 0)
    {
        memcpy(song->data, buf, buflen);
    }

    song->len = (int)buflen;

    mem_fclose(midi);
    mem_fclose(mus);

    return song;
}

static void TXM_UnRegisterSong(void *handle)
{
    textjs_song_t *song;

    song = (textjs_song_t *)handle;
    if (song == NULL)
    {
        return;
    }

    free(song->data);
    free(song);
}

static void TXM_PlaySong(void *handle, boolean looping)
{
    textjs_song_t *song;

    song = (textjs_song_t *)handle;
    if (song == NULL)
    {
        return;
    }

    mus_play(song->data, song->len, looping ? 1 : 0);
    music_playing = true;
}

static void TXM_StopSong(void)
{
    mus_stop();
    music_playing = false;
}

static boolean TXM_MusicIsPlaying(void)
{
    return music_playing;
}

static void TXM_Poll(void)
{
}

music_module_t DG_music_module = {
    music_devices,
    NUM_MUSIC_DEVICES,
    TXM_Init,
    TXM_Shutdown,
    TXM_SetMusicVolume,
    TXM_PauseMusic,
    TXM_ResumeMusic,
    TXM_RegisterSong,
    TXM_UnRegisterSong,
    TXM_PlaySong,
    TXM_StopSong,
    TXM_MusicIsPlaying,
    TXM_Poll
};

void I_InitTimidityConfig(void)
{
}

// Config variables i_sound.c binds; normally defined by the SDL mixer backend.
int use_libsamplerate = 0;
float libsamplerate_scale = 0.65f;
