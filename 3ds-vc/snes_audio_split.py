import os
import struct

# From https://gbatemp.net/threads/i-managed-to-extract-snes-roms-from-vc-with-working-audio.612523/

if __name__ == '__main__':
    if len(os.sys.argv) != 2:
        print("Use: python splita_rom_virtual_console_3ds.py /path/to/data.bin")
        os.sys.exit(1)

    fabs = os.sys.argv[1]

    try:
        with open(fabs, "rb") as fi:
            b = bytearray(fi.read())
            rom_size = struct.unpack('<I', b[0x31:0x34] + b'\0')[0]
            rom_data = b[0x60:0x60 + rom_size]
            print(f'ROM size: {rom_size} ({hex(rom_size)})')

            pcm_data = b[0x60 + rom_size:]
            print(f'PCM size: {len(pcm_data)} ({hex(len(pcm_data))})')

            with open('game.rom', 'wb') as fo:
                fo.write(rom_data)

            with open('game.pcm', 'wb') as fo:
                fo.write(pcm_data)

        print('SUCCESS')
    except Exception as e:
        print('ERROR' + str(e))