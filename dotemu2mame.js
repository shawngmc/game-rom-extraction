// dotemu2mame.js - convert data of games ported by DotEmu to MAME ROM sets
//
// Usage:
//   node dotemu2mame.js [ROM directory]
//
// Requirements:
// - Node.js v6 or later
// - [Microsoft Windows] .NET Framework 4.5 or later (included in Windows 8/10)
// - [Linux] /usr/bin/zip
//
// Supported games:
// - Double Dragon Trilogy (GOG.com)
//   * Double Dragon
//   * Double Dragon 2
//   * Double Dragon 3 ("mb7114h.ic38" is missing)
// - R-Type (Google Play)
// - R-Type II (Google Play)
// - Irem Arcade Hits (Mac App Store)
//   * Air Duel
//   * Battle Chopper
//   * Blade Master
//   * Cosmic Cop
//   * Dragon Breed
//   * Gunforce
//   * Gunforce 2
//   * Hammerin' Harry
//   * Image Fight
//   * In the Hunt
//   * Kung-Fu Master ("b-6f-.bin" is missing)
//   * Legend of Hero Tonma
//   * Mystic Riders
//   * Ninja Spirit ("proms" and "plds" ROMs are missing)
//   * R-Type Leo
//   * Superior Soldiers
//   * Undercover Cops
//   * Vigilante ("plds" ROMs are missing)
// - Raiden Legacy (Google Play, GOG.com)
//   * Raiden
//   * Raiden Fighters (wrong checksums)
//   * Raiden Fighters 2 (wrong checksums)
//   * Raiden Fighters Jet (wrong checksums)
// - Neo Geo (Steam, Google Play) (neogeo.zip is incomplete, cannot be run)
//   * Baseball Stars 2
//   * Blazing Star
//   * The King of Fighters '97
//   * The King of Fighters '98 (KOF '98 Ultimate Match is NOT supported)
//   * Metal Slug
//   * Metal Slug 2
//   * Metal Slug X (wrong checksums)
//   * Metal Slug 3
//   * Samurai Shodown II
//   * Shock Troopers
//   * Twinkle Star Sprites
//   * Fatal Fury Special (not tested, may not work)
//   * The Last Blade (not tested, may not work)
//   * Shock Troopers 2nd Squad (not tested, may not work)
//
// Changelog:
// - 2017-12-21: Place dummy files for missing ROMs.
// - 2017-12-20: Support Irem Arcade Hits (Mac App Store).
// - 2017-06-25: Support R-Type II (Google Play).
// - 2017-04-23: Initial release.

const child_process = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

Array.prototype.flatten = function() {
    return this.reduce((acc, cur) => acc.concat(
        Array.isArray(cur) ? cur.flatten() : cur
    ), []);
};

Array.prototype.flatMap = function(callback) {
    return this.map(callback).flatten();
};

Array.prototype.sum = function() {
    return this.reduce((acc, cur) => acc + cur, 0);
};

function split(buf, size)
{
    const ret = [];
    for (let i = 0; i < buf.length; i += size)
        ret.push(buf.slice(i, Math.min(i+size,buf.length)));
    return ret;
}

function split_at(buf, ...pos)
{
    const ret = [];
    pos = [0, ...pos, buf.length];
    for (let i = 1; i < pos.length; i++)
        ret.push(buf.slice(pos[i-1], pos[i]));
    return ret;
}

function interleave(buf, pat=[1,1])
{
    const step = pat.sum();
    return pat.map((n, index) => {
        const b = Buffer.allocUnsafe(buf.length * n / step);
        const offset = pat.slice(0, index).sum();
        if (n === 1)
            for (let i = 0; i < b.length; i++)
                b[i] = buf[i*step+offset];
        else { /* n === 2 */
            for (let i = 0; i < b.length/2; i++) {
                b[i*2+0] = buf[i*step+offset+1];
                b[i*2+1] = buf[i*step+offset+0];
            }
        }
        return b;
    });
}

function bitswap(val, ...indices)
{
    const n = indices.length;
    let ret = 0;
    for (let i = 0; i < n; i++)
        ret |= (val >> indices[i] & 1) << n-1-i;
    return ret;
}

function reverse_bitswap(val, ...indices)
{
    const n = indices.length;
    let ret = 0;
    for (let i = 0; i < n; i++)
        ret |= (val >> n-1-i & 1) << indices[i];
    return ret;
}

function sha1(buf)
{
    const hash = crypto.createHash('sha1');
    hash.update(buf);
    return hash.digest('hex');
}

function encode_gfx(buf, layout)
{
    const np = layout.planes;
    const dest = Buffer.alloc(buf.length * np / 8);

    if (Array.isArray(layout.total)) {
        const [num, den] = layout.total;
        layout = Object.assign({}, layout, {
            total: dest.length * 8 / layout.charincrement * num / den,
            planeoffset: layout.planeoffset.map(x => {
                if (Array.isArray(x)) {
                    let [num, den, add] = x;
                    add = add || 0;
                    return dest.length * 8 * num / den + add;
                }
                else
                    return x;
            })
        });
    }

    let i = 0;
    for (let c = 0; c < layout.total; c++) {
        const charoffset = layout.charincrement * c;
        for (let y = 0; y < layout.height; y++) {
            const yoffset = charoffset + layout.yoffset[y];
            for (let x = 0; x < layout.width; x++) {
                const xoffset = yoffset + layout.xoffset[x];
                for (let p = 0; p < np; p++) {
                    const offset = xoffset + layout.planeoffset[p];
                    dest[offset >> 3] |=
                        ((buf[i] >> np-1-p) & 1) << (~offset & 7);
                }
                i++;
            }
        }
    }
    return dest;
}

function zip(name, dir)
{
    let cmd;
    if (os.type() === 'Windows_NT')
        cmd = `powershell Add-Type -AssemblyName System.IO.Compression.FileSystem; [System.IO.Compression.ZipFile]::CreateFromDirectory('${dir}', '${name}.zip')`;
    else
        cmd = `zip -j ${name}.zip ${dir}/*`;
    child_process.execSync(cmd);
}

function convert_roms(name, srcdir, maps)
{
    const bins = {};
    for (const region in maps) {
        const map = maps[region];
        let bin;
        if (map.input instanceof Buffer)
            bin = map.input;
        else {
            let file;
            let layout;
            if (typeof map.input === 'string')
                file = map.input;
            else
                ({file, layout} = map.input);
            bin = fs.readFileSync(path.join(srcdir, file));
            if (layout)
                bin = encode_gfx(bin, layout);
        }
        if (map.transform)
            bin = map.transform(bin);
        bins[region] = bin;
    }

    const dstdir = fs.mkdtempSync(path.join(os.tmpdir(), name));
    for (const region in maps) {
        let bin = bins[region];
        let {output} = maps[region];
        if (typeof output === 'string') {
            output = [output];
            bin = [bin];
        }
        if (!Array.isArray(bin))
            bin = split(bin, bin.length/output.length);
        for (let i = 0; i < output.length; i++)
            fs.writeFileSync(path.join(dstdir, output[i]), bin[i]);
    }
    zipname = fix_mame_zip_name(name)
    zip(zipname, dstdir);
    for (const f of fs.readdirSync(dstdir))
        fs.unlinkSync(path.join(dstdir, f));
    fs.rmdirSync(dstdir);
    console.log(`saved as ${zipname}.zip.`);
}

// from https://github.com/mamedev/mame/blob/ddb290d5f615019c33c42b8d94e5a5254cabcf33/src/mame/video/vigilant.cpp
// license:BSD-3-Clause
// copyright-holders:Mike Balfour
function vigilant_reorder(src)
{
    const pages = 4;
    const width = 512;
    const height = 256;
    var dst = Buffer.alloc(src.length/2);

    var i = 0;
    for (var p = 0; p < pages; p++)
        for (var y = 0; y < height; y++) {
            var j = (width*pages*y + width*p) * 2;
            for (var x = 0; x < width; x++) {
                dst[i] = src[j] & 0xf;
                i++;
                j += 2;
            }
        }
    return dst;
}

const SPI = (function() {
// from https://github.com/mamedev/mame/blob/ddb290d5f615019c33c42b8d94e5a5254cabcf33/src/mame/machine/seibuspi.cpp
// license:BSD-3-Clause
// copyright-holders:Ville Linde, hap, Nicola Salmoria
function partial_borrow_diff(minu, sub, carry_mask, bits)
{
    let res = 0;
    let borrow = 0;

    for (let i = 0; i < bits; i++) {
        bit = (minu >> i & 1) - (sub >> i & 1) - borrow;
        res |= (bit & 1) << i;
        borrow = (carry_mask >> i & 1) & (bit >> 1);
    }
    return res ^ borrow;
}

const KEY_TABLE = [
    0x3ad7,0x54b1,0x2d41,0x8ca0,0xa69b,0x9018,0x9db9,0x6559,
    0xe9a7,0xb087,0x8a5e,0x821c,0xaafc,0x2ae7,0x557b,0xcd80,
    0xcfee,0x653e,0x9b31,0x7ab5,0x8b2a,0xbda8,0x707a,0x3c83,
    0xcbb7,0x7157,0x8226,0x5c4a,0x8bf2,0x6397,0x13e2,0x3102,
    0x8093,0x44cd,0x5f2d,0x7639,0xa7a4,0x9974,0x5263,0x8318,
    0xb78c,0xa120,0xafb4,0x615f,0x6e0b,0x1d7d,0x8c29,0x4466,
    0x3f35,0x794e,0xaea6,0x601c,0xe478,0xcf6e,0x4ee3,0xa009,
    0x4b99,0x51d3,0x3474,0x3e4d,0xe5b7,0x9088,0xb5c0,0xba9f,
    0x5646,0xa0af,0x970b,0xb14f,0x8216,0x2386,0x496d,0x9245,
    0x7e4c,0xad5f,0x89d9,0xb801,0xdf64,0x8ca8,0xe019,0xde9b,
    0x6836,0x70e2,0x7dcd,0x7ac1,0x98ef,0x71aa,0x7d6f,0x70bd,
    0x9e14,0x75b6,0x8153,0xab6c,0x1f85,0x79cd,0xb2a1,0x934a,
    0x6f74,0x37d7,0xa05a,0x6563,0x1972,0x2dcd,0x7e59,0x6a60,
    0x5163,0x84c4,0xc451,0x8d80,0x4287,0x57e8,0xacc9,0x539d,
    0xbe71,0xdb7c,0x9424,0xb224,0xcc0f,0xe3dd,0xb79c,0x461e,
    0x96a9,0x4c7c,0x5443,0x6b2b,0x3cdc,0xbee8,0x2602,0x3282,
    0x7f9c,0x59c3,0xc69a,0x39f4,0x5138,0xb7ca,0x6ca7,0x62e7,
    0xc455,0x56cf,0x8a9a,0x695c,0x5af2,0xdebf,0x4dbb,0xdaec,
    0xb564,0xc89c,0x7d2d,0x6dc3,0xa15a,0x6584,0xb8ea,0xb7ac,
    0x88d8,0xc5aa,0x98c5,0xc506,0xc13c,0x7f59,0xab65,0x8fc8,
    0x3a3c,0xd5f6,0x554d,0x5682,0x8ce7,0x40fc,0x8fd7,0x535c,
    0x6aa0,0x52fe,0x8834,0x5316,0x6c27,0x80a9,0x9e6f,0x2c08,
    0x4092,0xc7c1,0xc468,0x9520,0xbc4d,0xb621,0x3cdb,0xdce8,
    0x481f,0xd0bd,0x3a57,0x807e,0x3025,0x5aa0,0x5e49,0xa29b,
    0xd2d6,0x7bee,0x97f0,0xe28e,0x2fff,0x48e4,0x6367,0x933f,
    0x57c5,0x28d4,0x68a0,0xd22e,0x39a6,0x9d2b,0x7a64,0x7e72,
    0x5379,0xe86c,0x7554,0x8fbb,0xc06a,0x9533,0x7eec,0x4d52,
    0xa800,0x5d35,0xa47d,0xe515,0x8d19,0x703b,0x5a2e,0x627c,
    0x7cea,0x1b2c,0x5a05,0x8598,0x9e00,0xcf01,0x62d9,0x7a10,
    0x1f42,0x87ce,0x575d,0x6e23,0x86ef,0x93c2,0x3d1a,0x89aa,
    0xe199,0xba1d,0x1b72,0x4513,0x5131,0xc23c,0xba9f,0xa069,
    0xfbfb,0xda92,0x42b2,0x3a48,0xdb96,0x5fad,0xba96,0xc6eb
];

const SPI_BITSWAP = [
    [15,14,13,12,11,10, 9, 8, 7, 6, 5, 4, 3, 2, 1, 0],
    [ 7, 6, 5,14, 0,15, 4, 3, 2, 8, 9,10,11,12,13, 1],
    [ 9,15,14,13,12, 0, 1, 2,10, 8, 7, 6, 5, 4, 3,11],
    [ 5, 4, 3, 2, 9,14,13,12,11, 6, 7, 8, 1,15, 0,10],
    [12,11, 0, 7, 8, 5, 6,15,10,13,14, 1, 2, 3, 4, 9],
    [14, 0, 1, 2, 3, 9, 8, 7,15, 5, 6,13,12,11,10, 4],
    [13,12,11,10, 2, 7, 8, 9, 0,14,15, 3, 4, 5, 6, 1],
    [ 2, 9,10,11,12, 7, 6, 5,14, 3, 4, 0,15, 1, 8,13],
    [ 8, 7, 4, 3, 2,13,12,11, 0, 9,10,14,15, 6, 5, 1],
    [ 3, 2,10,11,12, 5,14, 0, 1, 4,15, 6, 7, 8, 9,13],
    [ 2,10, 6, 5, 4,14,13,12,11, 1, 0,15, 9, 8, 7, 3],
    [12,11, 8, 1,15, 3, 2, 9,10,13,14, 4, 5, 6, 7, 0],
    [ 8, 7, 0,11,12, 5, 6,15,14, 9,10, 1, 2, 3, 4,13],
    [ 3, 2, 1, 0,14, 9, 8, 7, 6, 4,15,13,12,11,10, 5],
    [ 2,10,11,12,13, 7, 8, 9,15, 1, 0, 3, 4, 5, 6,14],
    [12,11,10, 9, 2, 7, 6, 5, 4,13,14, 0,15, 1, 8, 3]
];

function key(table, addr)
{
    const xorbit = 8 + ((table & 0xc) >> 2);
    return ((KEY_TABLE[addr & 0xff] >> 4) >> table & 1) ^ (addr >> xorbit & 1);
}

function seibuspi_sprite_encrypt(src)
{
    const rom_size = src.length / 3;
    for (let i = 0; i < rom_size/2; i++) {
        const addr = i >> 8;
        const plane5 = src[2*i+0*rom_size+0];
        const plane4 = src[2*i+0*rom_size+1];
        const plane3 = src[2*i+1*rom_size+0];
        const plane2 = src[2*i+1*rom_size+1];
        const plane1 = src[2*i+2*rom_size+0];
        const plane0 = src[2*i+2*rom_size+1];

        let s1 = 0;
        let s2 = 0;
        for (let j = 0; j < 8; j++) {
            s1 |= (plane5 >> j & 1) << 2*j+1 |
                  (plane4 >> j & 1) << 2*j+0;
            s2 |= (plane3 >> j & 1) << 4*j+3 |
                  (plane2 >> j & 1) << 4*j+2 |
                  (plane1 >> j & 1) << 4*j+1 |
                  (plane0 >> j & 1) << 4*j+0;
        }

        const sub1 = (addr >> 11 & 1) <<  0 |
                     (addr >> 10 & 1) <<  1 |
                     key(10, addr)    <<  2 |
                     key( 5, addr)    <<  3 |
                     key( 4, addr)    <<  4 |
                     (addr >> 11 & 1) <<  5 |
                     (addr >> 11 & 1) <<  6 |
                     key( 7, addr)    <<  7 |
                     key( 6, addr)    <<  8 |
                     key( 1, addr)    <<  9 |
                     key( 0, addr)    << 10 |
                     (addr >> 11 & 1) << 11 |
                     key( 9, addr)    << 12 |
                     key( 8, addr)    << 13 |
                     key( 3, addr)    << 14 |
                     key( 2, addr)    << 15;

        const sub2 = key( 0, addr)    <<  0 |
                     key( 1, addr)    <<  1 |
                     key( 2, addr)    <<  2 |
                     key( 3, addr)    <<  3 |
                     key( 4, addr)    <<  4 |
                     key( 5, addr)    <<  5 |
                     key( 6, addr)    <<  6 |
                     key( 7, addr)    <<  7 |
                     key( 8, addr)    <<  8 |
                     key( 9, addr)    <<  9 |
                     key(10, addr)    << 10 |
                     (addr >> 10 & 1) << 11 |
                     (addr >> 11 & 1) << 12 |
                     (addr >> 11 & 1) << 13 |
                     (addr >> 11 & 1) << 14 |
                     (addr >> 11 & 1) << 15 |
                     (addr >> 11 & 1) << 16 |
                     key( 7, addr)    << 17 |
                     (addr >> 11 & 1) << 18 |
                     key( 6, addr)    << 19 |
                     (addr >> 11 & 1) << 20 |
                     key( 5, addr)    << 21 |
                     (addr >> 11 & 1) << 22 |
                     key( 4, addr)    << 23 |
                     (addr >> 10 & 1) << 24 |
                     key( 3, addr)    << 25 |
                     key(10, addr)    << 26 |
                     key( 2, addr)    << 27 |
                     key( 9, addr)    << 28 |
                     key( 1, addr)    << 29 |
                     key( 8, addr)    << 30 |
                     key( 0, addr)    << 31;

        s1 = partial_borrow_diff(s1 ^ 0x843a,     sub1, 0x3a59,     16);
        s2 = partial_borrow_diff(s2 ^ 0xc8e29f84, sub2, 0x28d49cac, 32);

        let y1 = (s2 >> 22 & 1) <<  0 |
                 (s1 >>  6 & 1) <<  1 |
                 (s2 >>  6 & 1) <<  2 |
                 (s2 >> 16 & 1) <<  3 |
                 (s1 >>  0 & 1) <<  4 |
                 (s2 >>  0 & 1) <<  5 |
                 (s2 >> 11 & 1) <<  6 |
                 (s1 >> 11 & 1) <<  7 |
                 (s2 >> 27 & 1) <<  8 |
                 (s2 >> 21 & 1) <<  9 |
                 (s1 >>  5 & 1) << 10 |
                 (s2 >>  5 & 1) << 11 |
                 (s2 >> 15 & 1) << 12 |
                 (s1 >> 15 & 1) << 13 |
                 (s2 >> 31 & 1) << 14 |
                 (s2 >> 10 & 1) << 15;

        let y2 = (s1 >> 10 & 1) <<  0 |
                 (s2 >> 26 & 1) <<  1 |
                 (s2 >> 20 & 1) <<  2 |
                 (s1 >>  4 & 1) <<  3 |
                 (s2 >>  4 & 1) <<  4 |
                 (s2 >> 14 & 1) <<  5 |
                 (s1 >> 14 & 1) <<  6 |
                 (s2 >> 30 & 1) <<  7 |
                 (s2 >>  9 & 1) <<  8 |
                 (s1 >>  9 & 1) <<  9 |
                 (s2 >> 25 & 1) << 10 |
                 (s2 >> 19 & 1) << 11 |
                 (s1 >>  3 & 1) << 12 |
                 (s2 >>  3 & 1) << 13 |
                 (s2 >> 13 & 1) << 14 |
                 (s1 >> 13 & 1) << 15;

        let y3 = (s2 >>  1 & 1) <<  0 |
                 (s2 >> 24 & 1) <<  1 |
                 (s1 >>  8 & 1) <<  2 |
                 (s2 >>  8 & 1) <<  3 |
                 (s2 >> 29 & 1) <<  4 |
                 (s2 >>  2 & 1) <<  5 |
                 (s1 >>  2 & 1) <<  6 |
                 (s1 >>  1 & 1) <<  7 |
                 (s2 >> 17 & 1) <<  8 |
                 (s2 >>  7 & 1) <<  9 |
                 (s2 >> 23 & 1) << 10 |
                 (s2 >> 12 & 1) << 11 |
                 (s1 >> 12 & 1) << 12 |
                 (s2 >> 28 & 1) << 13 |
                 (s1 >>  7 & 1) << 14 |
                 (s2 >> 18 & 1) << 15;

        y3 = reverse_bitswap(y3, ...SPI_BITSWAP[KEY_TABLE[addr & 0xff] & 0xf]);

        src[2*i+0*rom_size+0] = y1 >> 0 & 0xff;
        src[2*i+0*rom_size+1] = y1 >> 8 & 0xff;
        src[2*i+1*rom_size+0] = y2 >> 0 & 0xff;
        src[2*i+1*rom_size+1] = y2 >> 8 & 0xff;
        src[2*i+2*rom_size+0] = y3 >> 0 & 0xff;
        src[2*i+2*rom_size+1] = y3 >> 8 & 0xff;
    }
    return src;
}

function sprite_reorder(buf)
{
    const tmp = Buffer.allocUnsafe(64);
    for (let i = 0; i < buf.length; i += 64) {
        for (let j = 0; j < 16; j++) {
            tmp[2*j+ 0] = buf[i+4*j+0];
            tmp[2*j+ 1] = buf[i+4*j+1];
            tmp[2*j+32] = buf[i+4*j+2];
            tmp[2*j+33] = buf[i+4*j+3];
        }
        tmp.copy(buf, i);
    }
}

function seibuspi_rise10_sprite_encrypt(rom)
{
    const size = rom.length / 3;
    sprite_reorder(rom);

    for (let i = 0; i < size/2; i++) {
        let plane54   = rom[0*size+2*i+0] <<  8 |
                        rom[0*size+2*i+1] <<  0;
        let plane3210 = rom[1*size+2*i+0] << 24 |
                        rom[1*size+2*i+1] << 16 |
                        rom[2*size+2*i+0] <<  8 |
                        rom[2*size+2*i+1] <<  0;

        plane54   = partial_borrow_diff(plane54 ^ 0x6699, 0xabcb, 0x55aa, 16);
        plane3210 = partial_borrow_diff(plane3210 ^ 0x0ca352a9,
                                        0x654321d9 ^ 0x42, 0x1d463748, 32);

        plane3210 = reverse_bitswap(
            plane3210, 23,13,24,4,16,12,25,30, 3,5,29,17,14,22,2,11,
	               27,6,15,21,1,28,10,20, 7,31,26,0,18,9,19,8
        );

        rom[0*size+2*i+0] = plane54   >>  0 & 0xff;
        rom[0*size+2*i+1] = plane54   >>  8 & 0xff;
        rom[1*size+2*i+0] = plane3210 >>  0 & 0xff;
        rom[1*size+2*i+1] = plane3210 >>  8 & 0xff;
        rom[2*size+2*i+0] = plane3210 >> 16 & 0xff;
        rom[2*size+2*i+1] = plane3210 >> 24 & 0xff;
    }
}

function seibuspi_rise11_sprite_encrypt(rom, k1, k2, k3, k4, k5)
{
    const size = rom.length / 3;
    sprite_reorder(rom);

    for (let i = 0; i < size/2; i++) {
        let plane543 = rom[0*size+2*i+0] << 16 |
                       rom[0*size+2*i+1] <<  8 |
                       rom[1*size+2*i+0] <<  0;
        let plane210 = rom[1*size+2*i+1] << 16 |
                       rom[2*size+2*i+0] <<  8 |
                       rom[2*size+2*i+1] <<  0;

        plane543 = partial_borrow_diff(plane543 ^ k3, k1, k2, 32);
        plane210 = partial_borrow_diff(plane210 ^ k5, i,  k4, 24);

        rom[0*size+2*i+0] = (plane210 >> 12 & 1) << 0 |
                            (plane210 >>  1 & 1) << 1 |
                            (plane543 >>  9 & 1) << 2 |
                            (plane543 >> 16 & 1) << 3 |
                            (plane543 >> 21 & 1) << 4 |
                            (plane210 >> 22 & 1) << 5 |
                            (plane543 >>  1 & 1) << 6 |
                            (plane210 >>  4 & 1) << 7;
        rom[0*size+2*i+1] = (plane210 >> 16 & 1) << 0 |
                            (plane543 >> 11 & 1) << 1 |
                            (plane210 >> 19 & 1) << 2 |
                            (plane543 >>  7 & 1) << 3 |
                            (plane543 >>  8 & 1) << 4 |
                            (plane210 >>  2 & 1) << 5 |
                            (plane210 >>  0 & 1) << 6 |
                            (plane543 >> 18 & 1) << 7;
        rom[1*size+2*i+0] = (plane543 >> 23 & 1) << 0 |
                            (plane210 >>  9 & 1) << 1 |
                            (plane543 >> 13 & 1) << 2 |
                            (plane210 >> 21 & 1) << 3 |
                            (plane210 >>  6 & 1) << 4 |
                            (plane543 >> 10 & 1) << 5 |
                            (plane210 >> 11 & 1) << 6 |
                            (plane543 >> 17 & 1) << 7;
        rom[1*size+2*i+1] = (plane210 >> 14 & 1) << 0 |
                            (plane210 >>  7 & 1) << 1 |
                            (plane543 >> 14 & 1) << 2 |
                            (plane543 >>  0 & 1) << 3 |
                            (plane543 >>  4 & 1) << 4 |
                            (plane543 >> 20 & 1) << 5 |
                            (plane210 >>  5 & 1) << 6 |
                            (plane210 >> 20 & 1) << 7;
        rom[2*size+2*i+0] = (plane210 >>  3 & 1) << 0 |
                            (plane543 >> 12 & 1) << 1 |
                            (plane543 >> 22 & 1) << 2 |
                            (plane543 >>  3 & 1) << 3 |
                            (plane543 >>  6 & 1) << 4 |
                            (plane543 >> 15 & 1) << 5 |
                            (plane210 >> 18 & 1) << 6 |
                            (plane210 >> 10 & 1) << 7;
        rom[2*size+2*i+1] = (plane210 >>  8 & 1) << 0 |
                            (plane543 >> 19 & 1) << 1 |
                            (plane210 >> 17 & 1) << 2 |
                            (plane210 >> 13 & 1) << 3 |
                            (plane543 >>  2 & 1) << 4 |
                            (plane210 >> 15 & 1) << 5 |
                            (plane543 >>  5 & 1) << 6 |
                            (plane210 >> 23 & 1) << 7;
    }
}

function seibuspi_rise11_sprite_encrypt_rfjet(rom)
{
    seibuspi_rise11_sprite_encrypt(rom, 0xabcb64, 0x55aadd,
                                   0xab6a4c, 0xd6375b, 0x8bf23b);
    return rom;
}

// from https://github.com/mamedev/mame/blob/6c23897483a0201dd0b65b450253fd9bf8fb8723/src/mame/video/seibuspi.cpp
// license:BSD-3-Clause
// copyright-holders:Ville Linde, hap, Nicola Salmoria
function encrypt_tile(val, tileno, key1, key2, key3)
{
    val = partial_borrow_diff(val ^ key3, tileno + key1, key2, 24);
    return reverse_bitswap(
        val, 18,19,9,5,10,17,16,20, 21,22,6,11,15,14,4,23, 0,1,7,8,13,12,3,2
    );
}

function encrypt_text(rom, key1, key2, key3)
{
    for (let i = 0; i < 0x10000; i++) {
        let w = rom[i*3+0] << 16 | rom[i*3+1] << 8 | rom[i*3+2];
        w = encrypt_tile(w, i >> 4, key1, key2, key3);
        rom[i*3+0] = w >> 16 & 0xff;
        rom[i*3+1] = w >>  8 & 0xff;
        rom[i*3+2] = w >>  0 & 0xff;
    }
}

function encrypt_bg(rom, key1, key2, key3)
{
    for (let j = 0; j < rom.length; j += 0xc0000) {
        for (let i = 0; i < 0x40000; i++) {
            let w = rom[j+i*3+0] << 16 | rom[j+i*3+1] << 8 | rom[j+i*3+2];
            w = encrypt_tile(w, i >> 6, key1, key2, key3);
            rom[j+i*3+0] = w >> 16 & 0xff;
            rom[j+i*3+1] = w >>  8 & 0xff;
            rom[j+i*3+2] = w >>  0 & 0xff;
        }
    }
}

function seibuspi_text_encrypt(rom)
{
    encrypt_text(rom, 0x5a3845, 0x77cf5b, 0x1378df);
    return rom;
}

function seibuspi_bg_encrypt(rom)
{
    encrypt_bg(rom, 0x5a3845, 0x77cf5b, 0x1378df);
    return rom;
}

function rdft2_text_encrypt(rom)
{
    encrypt_text(rom, 0x823146, 0x4de2f8, 0x157adc);
    return rom;
}

function rdft2_bg_encrypt(rom)
{
    encrypt_bg(rom, 0x823146, 0x4de2f8, 0x157adc);
    return rom;
}

function rfjet_text_encrypt(rom)
{
    encrypt_text(rom, 0xaea754, 0xfe8530, 0xccb666);
    return rom;
}

function rfjet_bg_encrypt(rom)
{
    encrypt_bg(rom, 0xaea754, 0xfe8530, 0xccb666);
    return rom;
}

return {
    seibuspi_text_encrypt: seibuspi_text_encrypt,
    seibuspi_bg_encrypt: seibuspi_bg_encrypt,
    seibuspi_sprite_encrypt: seibuspi_sprite_encrypt,
    rdft2_text_encrypt: rdft2_text_encrypt,
    rdft2_bg_encrypt: rdft2_bg_encrypt,
    seibuspi_rise10_sprite_encrypt: seibuspi_rise10_sprite_encrypt,
    rfjet_text_encrypt: rfjet_text_encrypt,
    rfjet_bg_encrypt: rfjet_bg_encrypt,
    seibuspi_rise11_sprite_encrypt_rfjet: seibuspi_rise11_sprite_encrypt_rfjet
};
})();

const NeoGeo = (function() {
// from http://i486.mods.jp/ichild/?page_id=62
// Original author: Imaha486
function deoptimize_sprites(buf)
{
    const tmp = Buffer.allocUnsafe(0x80);
    for (let i = 0; i < buf.length; i += 0x80) {
        tmp.fill(0);
        for (let y = 0; y < 0x10; y++) {
            let dstData;
            dstData = buf[i+(y*8)+0] <<  0 |
                      buf[i+(y*8)+1] <<  8 |
                      buf[i+(y*8)+2] << 16 |
                      buf[i+(y*8)+3] << 24;
            for (let x = 0; x < 8; x++) {
                tmp[0x43 | y << 2] |= (dstData >> x*4+3 & 1) << 7-x;
                tmp[0x41 | y << 2] |= (dstData >> x*4+2 & 1) << 7-x;
                tmp[0x42 | y << 2] |= (dstData >> x*4+1 & 1) << 7-x;
                tmp[0x40 | y << 2] |= (dstData >> x*4+0 & 1) << 7-x;
            }

            dstData = buf[i+(y*8)+4] <<  0 |
                      buf[i+(y*8)+5] <<  8 |
                      buf[i+(y*8)+6] << 16 |
                      buf[i+(y*8)+7] << 24;
            for (let x = 0; x < 8; x++) {
                tmp[0x03 | y << 2] |= (dstData >> x*4+3 & 1) << 7-x;
                tmp[0x01 | y << 2] |= (dstData >> x*4+2 & 1) << 7-x;
                tmp[0x02 | y << 2] |= (dstData >> x*4+1 & 1) << 7-x;
                tmp[0x00 | y << 2] |= (dstData >> x*4+0 & 1) << 7-x;
            }
        }
        tmp.copy(buf, i);
    }
    return buf;
}

function sfix_reorder(bin)
{
    const tmp = Buffer.allocUnsafe(32);
    for (let i = 0; i < bin.length; i += 32) {
        for (let j = 0; j < 8; j++) {
            tmp[j+16] = bin[i+4*j+0];
            tmp[j+24] = bin[i+4*j+1];
            tmp[j+ 0] = bin[i+4*j+2];
            tmp[j+ 8] = bin[i+4*j+3];
        }
        tmp.copy(bin, i);
    }
    return bin;
}

// from https://github.com/mamedev/mame/blob/6c23897483a0201dd0b65b450253fd9bf8fb8723/src/devices/bus/neogeo/prot_sma.cpp
// license:BSD-3-Clause
// copyright-holders:S. Smith,David Haywood,Fabio Priuli
function mslug3_encrypt_68k(buf)
{
    let rom = buf.slice(0x100000);
    const tmp = Buffer.allocUnsafe(0x10000);
    for (let i = 0; i < 0x800000/2; i += 0x10000/2) {
        rom.copy(tmp, 0, i*2, i*2+0x10000);
        for (let j = 0; j < 0x10000/2; j++) {
            const k = bitswap(j, 2,11,0,14,6,4,13,8,9,3,10,7,5,12,1);
            rom[(i+k)*2+0] = tmp[j*2+0];
            rom[(i+k)*2+1] = tmp[j*2+1];
        }
    }

    rom = buf;
    for (let i = 0; i < 0x0c0000/2; i++) {
        const j = bitswap(i, 18,15,2,1,13,3,0,9,6,16,4,11,5,7,12,17,14,10,8);
        rom[0x5d0000+j*2+0] = rom[i*2+0];
        rom[0x5d0000+j*2+1] = rom[i*2+1];
    }

    rom = buf.slice(0x100000);
    for (let i = 0; i < 0x800000/2; i++) {
        let w = rom[i*2+0] | rom[i*2+1] << 8;
        w = reverse_bitswap(w, 4,11,14,3,1,13,0,7,2,8,12,15,10,9,5,6);
        rom[i*2+0] = w >> 0 & 0xff;
        rom[i*2+1] = w >> 8 & 0xff;
    }
}

// from https://github.com/mamedev/mame/blob/ddb290d5f615019c33c42b8d94e5a5254cabcf33/src/devices/bus/neogeo/prot_cmc.h
// license:BSD-3-Clause
// copyright-holders:S. Smith,David Haywood,Fabio Priuli
const MSLUG3_GFX_KEY = 0xad;

// from https://github.com/mamedev/mame/blob/6c23897483a0201dd0b65b450253fd9bf8fb8723/src/devices/bus/neogeo/prot_cmc.cpp
// license:BSD-3-Clause
// copyright-holders:S. Smith,David Haywood,Fabio Priuli
const CMC42_TYPE0_T03 = [
    0xfb, 0x86, 0x9d, 0xf1, 0xbf, 0x80, 0xd5, 0x43, 0xab, 0xb3, 0x9f, 0x6a, 0x33, 0xd9, 0xdb, 0xb6,
    0x66, 0x08, 0x69, 0x88, 0xcc, 0xb7, 0xde, 0x49, 0x97, 0x64, 0x1f, 0xa6, 0xc0, 0x2f, 0x52, 0x42,
    0x44, 0x5a, 0xf2, 0x28, 0x98, 0x87, 0x96, 0x8a, 0x83, 0x0b, 0x03, 0x61, 0x71, 0x99, 0x6b, 0xb5,
    0x1a, 0x8e, 0xfe, 0x04, 0xe1, 0xf7, 0x7d, 0xdd, 0xed, 0xca, 0x37, 0xfc, 0xef, 0x39, 0x72, 0xda,
    0xb8, 0xbe, 0xee, 0x7f, 0xe5, 0x31, 0x78, 0xf3, 0x91, 0x9a, 0xd2, 0x11, 0x19, 0xb9, 0x09, 0x4c,
    0xfd, 0x6d, 0x2a, 0x4d, 0x65, 0xa1, 0x89, 0xc7, 0x75, 0x50, 0x21, 0xfa, 0x16, 0x00, 0xe9, 0x12,
    0x74, 0x2b, 0x1e, 0x4f, 0x14, 0x01, 0x70, 0x3a, 0x4e, 0x3f, 0xf5, 0xf4, 0x1d, 0x3d, 0x15, 0x27,
    0xa7, 0xff, 0x45, 0xe0, 0x6e, 0xf9, 0x54, 0xc8, 0x48, 0xad, 0xa5, 0x0a, 0xf6, 0x2d, 0x2c, 0xe2,
    0x68, 0x67, 0xd6, 0x85, 0xb4, 0xc3, 0x34, 0xbc, 0x62, 0xd3, 0x5f, 0x84, 0x06, 0x5b, 0x0d, 0x95,
    0xea, 0x5e, 0x9e, 0xd4, 0xeb, 0x90, 0x7a, 0x05, 0x81, 0x57, 0xe8, 0x60, 0x2e, 0x20, 0x25, 0x7c,
    0x46, 0x0c, 0x93, 0xcb, 0xbd, 0x17, 0x7e, 0xec, 0x79, 0xb2, 0xc2, 0x22, 0x41, 0xb1, 0x10, 0xac,
    0xa8, 0xbb, 0x9b, 0x82, 0x4b, 0x9c, 0x8b, 0x07, 0x47, 0x35, 0x24, 0x56, 0x8d, 0xaf, 0xe6, 0x26,
    0x40, 0x38, 0xc4, 0x5d, 0x1b, 0xc5, 0xd1, 0x0f, 0x6c, 0x7b, 0xb0, 0xe3, 0xa3, 0x23, 0x6f, 0x58,
    0xc1, 0xba, 0xcf, 0xd7, 0xa2, 0xe7, 0xd0, 0x63, 0x5c, 0xf8, 0x73, 0xa0, 0x13, 0xdc, 0x29, 0xcd,
    0xc9, 0x76, 0xae, 0x8f, 0xe4, 0x59, 0x30, 0xaa, 0x94, 0x1c, 0x3c, 0x0e, 0x55, 0x92, 0x77, 0x32,
    0xc6, 0xce, 0x18, 0x36, 0xdf, 0xa9, 0x8c, 0xd8, 0xa4, 0xf0, 0x3b, 0x51, 0x4a, 0x02, 0x3e, 0x53
];

const CMC42_TYPE0_T12 = [
    0x1f, 0xac, 0x4d, 0xcd, 0xca, 0x70, 0x02, 0x6b, 0x18, 0x40, 0x62, 0xb2, 0x3f, 0x9b, 0x5b, 0xef,
    0x69, 0x68, 0x71, 0x3b, 0xcb, 0xd4, 0x30, 0xbc, 0x47, 0x72, 0x74, 0x5e, 0x84, 0x4c, 0x1b, 0xdb,
    0x6a, 0x35, 0x1d, 0xf5, 0xa1, 0xb3, 0x87, 0x5d, 0x57, 0x28, 0x2f, 0xc4, 0xfd, 0x24, 0x26, 0x36,
    0xad, 0xbe, 0x61, 0x63, 0x73, 0xaa, 0x82, 0xee, 0x29, 0xd0, 0xdf, 0x8c, 0x15, 0xb5, 0x96, 0xf3,
    0xdd, 0x7e, 0x3a, 0x37, 0x58, 0x7f, 0x0c, 0xfc, 0x0b, 0x07, 0xe8, 0xf7, 0xf4, 0x14, 0xb8, 0x81,
    0xb6, 0xd7, 0x1e, 0xc8, 0x85, 0xe6, 0x9d, 0x33, 0x60, 0xc5, 0x95, 0xd5, 0x55, 0x00, 0xa3, 0xb7,
    0x7d, 0x50, 0x0d, 0xd2, 0xc1, 0x12, 0xe5, 0xed, 0xd8, 0xa4, 0x9c, 0x8f, 0x2a, 0x4f, 0xa8, 0x01,
    0x52, 0x83, 0x65, 0xea, 0x9a, 0x6c, 0x44, 0x4a, 0xe2, 0xa5, 0x2b, 0x46, 0xe1, 0x34, 0x25, 0xf8,
    0xc3, 0xda, 0xc7, 0x6e, 0x48, 0x38, 0x7c, 0x78, 0x06, 0x53, 0x64, 0x16, 0x98, 0x3c, 0x91, 0x42,
    0x39, 0xcc, 0xb0, 0xf1, 0xeb, 0x13, 0xbb, 0x05, 0x32, 0x86, 0x0e, 0xa2, 0x0a, 0x9e, 0xfa, 0x66,
    0x54, 0x8e, 0xd3, 0xe7, 0x19, 0x20, 0x77, 0xec, 0xff, 0xbd, 0x6d, 0x43, 0x23, 0x03, 0xab, 0x75,
    0x3d, 0xcf, 0xd1, 0xde, 0x92, 0x31, 0xa7, 0x45, 0x4b, 0xc2, 0x97, 0xf9, 0x7a, 0x88, 0xd9, 0x1c,
    0xe9, 0xe4, 0x10, 0xc9, 0x22, 0x2d, 0x90, 0x76, 0x17, 0x79, 0x04, 0x51, 0x1a, 0x5a, 0x5f, 0x2c,
    0x21, 0x6f, 0x3e, 0xe0, 0xf0, 0xbf, 0xd6, 0x94, 0x0f, 0x80, 0x11, 0xa0, 0x5c, 0xa9, 0x49, 0x2e,
    0xce, 0xaf, 0xa6, 0x9f, 0x7b, 0x99, 0xb9, 0xb4, 0xe3, 0xfb, 0xf6, 0x27, 0xf2, 0x93, 0xfe, 0x08,
    0x67, 0xae, 0x09, 0x89, 0xdc, 0x4e, 0xc6, 0xc0, 0x8a, 0xb1, 0x59, 0x8b, 0x41, 0x56, 0x8d, 0xba
];

const CMC42_TYPE1_T03 = [
    0xa9, 0x17, 0xaf, 0x0d, 0x34, 0x6e, 0x53, 0xb6, 0x7f, 0x58, 0xe9, 0x14, 0x5f, 0x55, 0xdb, 0xd4,
    0x42, 0x80, 0x99, 0x59, 0xa8, 0x3a, 0x57, 0x5d, 0xd5, 0x6f, 0x4c, 0x68, 0x35, 0x46, 0xa6, 0xe7,
    0x7b, 0x71, 0xe0, 0x93, 0xa2, 0x1f, 0x64, 0x21, 0xe3, 0xb1, 0x98, 0x26, 0xab, 0xad, 0xee, 0xe5,
    0xbb, 0xd9, 0x1e, 0x2e, 0x95, 0x36, 0xef, 0x23, 0x79, 0x45, 0x04, 0xed, 0x13, 0x1d, 0xf4, 0x85,
    0x96, 0xec, 0xc2, 0x32, 0xaa, 0x7c, 0x15, 0xd8, 0xda, 0x92, 0x90, 0x9d, 0xb7, 0x56, 0x6a, 0x66,
    0x41, 0xfc, 0x00, 0xf6, 0x50, 0x24, 0xcf, 0xfb, 0x11, 0xfe, 0x82, 0x48, 0x9b, 0x27, 0x1b, 0x67,
    0x4e, 0x84, 0x69, 0x97, 0x6d, 0x8c, 0xd2, 0xba, 0x74, 0xf9, 0x8f, 0xa5, 0x54, 0x5c, 0xcd, 0x73,
    0x07, 0xd1, 0x01, 0x09, 0xf1, 0x19, 0x3b, 0x5e, 0x87, 0x30, 0x76, 0xcc, 0xc0, 0x5a, 0xa7, 0x49,
    0x22, 0xfa, 0x16, 0x02, 0xdf, 0xa4, 0xff, 0xb3, 0x75, 0x33, 0xbd, 0x88, 0x2f, 0xcb, 0x2a, 0x44,
    0xb8, 0xbf, 0x1c, 0x0f, 0x81, 0x10, 0x43, 0xb4, 0xc8, 0x7e, 0x9a, 0x25, 0xea, 0x83, 0x4b, 0x38,
    0x7a, 0xd7, 0x3d, 0x1a, 0x4f, 0x62, 0x51, 0xc9, 0x47, 0x0e, 0xce, 0x3f, 0xc7, 0x4d, 0x2c, 0xa1,
    0x86, 0xb9, 0xc5, 0xca, 0xdd, 0x6b, 0x70, 0x6c, 0x91, 0x9c, 0xbe, 0x0a, 0x9f, 0xf5, 0x94, 0xbc,
    0x18, 0x2b, 0x60, 0x20, 0x29, 0xf7, 0xf2, 0x28, 0xc4, 0xa0, 0x0b, 0x65, 0xde, 0x8d, 0x78, 0x12,
    0x3e, 0xd0, 0x77, 0x08, 0x8b, 0xae, 0x05, 0x31, 0x3c, 0xd6, 0xa3, 0x89, 0x06, 0xdc, 0x52, 0x72,
    0xb0, 0xb5, 0x37, 0xd3, 0xc3, 0x8a, 0xc6, 0xf0, 0xc1, 0x61, 0xfd, 0x4a, 0x5b, 0x7d, 0x9e, 0xf3,
    0x63, 0x40, 0x2d, 0xe8, 0xb2, 0xe6, 0x39, 0x03, 0xeb, 0x8e, 0xe1, 0x0c, 0xe4, 0xe2, 0xf8, 0xac
];

const CMC42_TYPE1_T12 = [
    0xea, 0xe6, 0x5e, 0xa7, 0x8e, 0xac, 0x34, 0x03, 0x30, 0x97, 0x52, 0x53, 0x76, 0xf2, 0x62, 0x0b,
    0x0a, 0xfc, 0x94, 0xb8, 0x67, 0x36, 0x11, 0xbc, 0xae, 0xca, 0xfa, 0x15, 0x04, 0x2b, 0x17, 0xc4,
    0x3e, 0x5b, 0x59, 0x01, 0x57, 0xe2, 0xba, 0xb7, 0xd1, 0x3f, 0xf0, 0x6a, 0x9c, 0x2a, 0xcb, 0xa9,
    0xe3, 0x2c, 0xc0, 0x0f, 0x46, 0x91, 0x8a, 0xd0, 0x98, 0xc5, 0xa6, 0x1b, 0x96, 0x29, 0x12, 0x09,
    0x63, 0xed, 0xe0, 0xa2, 0x86, 0x77, 0xbe, 0xe5, 0x65, 0xdb, 0xbd, 0x50, 0xb3, 0x9d, 0x1a, 0x4e,
    0x79, 0x0c, 0x00, 0x43, 0xdf, 0x3d, 0x54, 0x33, 0x8f, 0x89, 0xa8, 0x7b, 0xf9, 0xd5, 0x27, 0x82,
    0xbb, 0xc2, 0x8c, 0x47, 0x88, 0x6b, 0xb4, 0xc3, 0xf8, 0xaa, 0x06, 0x1e, 0x83, 0x7d, 0x05, 0x78,
    0x85, 0xf6, 0x6e, 0x2e, 0xec, 0x5a, 0x31, 0x45, 0x38, 0x14, 0x16, 0x8b, 0x02, 0xe4, 0x4f, 0xb0,
    0xbf, 0xab, 0xa4, 0x9e, 0x48, 0x60, 0x19, 0x35, 0x08, 0xde, 0xdd, 0x66, 0x90, 0x51, 0xcc, 0xa3,
    0xaf, 0x70, 0x9b, 0x75, 0x95, 0x49, 0x6c, 0x64, 0x72, 0x7e, 0x44, 0xa0, 0x73, 0x25, 0x68, 0x55,
    0x1f, 0x40, 0x7a, 0x74, 0x0e, 0x8d, 0xdc, 0x1c, 0x71, 0xc8, 0xcf, 0xd7, 0xe8, 0xce, 0xeb, 0x32,
    0x3a, 0xee, 0x07, 0x61, 0x4d, 0xfe, 0x5c, 0x7c, 0x56, 0x2f, 0x2d, 0x5f, 0x6f, 0x9f, 0x81, 0x22,
    0x58, 0x4b, 0xad, 0xda, 0xb9, 0x10, 0x18, 0x23, 0xe1, 0xf3, 0x6d, 0xe7, 0xe9, 0x28, 0xd6, 0xd8,
    0xf4, 0x4c, 0x39, 0x21, 0xb2, 0x84, 0xc1, 0x24, 0x26, 0xf1, 0x93, 0x37, 0xc6, 0x4a, 0xcd, 0x20,
    0xc9, 0xd9, 0xc7, 0xb1, 0xff, 0x99, 0xd4, 0x5d, 0xb5, 0xa1, 0x87, 0x0d, 0x69, 0x92, 0x13, 0x80,
    0xd2, 0xd3, 0xfd, 0x1d, 0xf5, 0x3b, 0xa5, 0x7f, 0xef, 0x9a, 0xb6, 0x42, 0xfb, 0x3c, 0xf7, 0x41
];

const CMC42_ADDRESS_8_15_XOR1 = [
    0x00, 0xb1, 0x1e, 0xc5, 0x3d, 0x40, 0x45, 0x5e, 0xf2, 0xf8, 0x04, 0x63, 0x36, 0x87, 0x88, 0xbf,
    0xab, 0xcc, 0x78, 0x08, 0xdd, 0x20, 0xd4, 0x35, 0x09, 0x8e, 0x44, 0xae, 0x33, 0xa9, 0x9e, 0xcd,
    0xb3, 0xe5, 0xad, 0x41, 0xda, 0xbe, 0xf4, 0x16, 0x57, 0x2e, 0x53, 0x67, 0xaf, 0xdb, 0x8a, 0xd8,
    0x34, 0x17, 0x3c, 0x01, 0x55, 0x73, 0xcf, 0xe3, 0xe8, 0xc7, 0x0d, 0xe9, 0xa3, 0x13, 0x0c, 0xf6,
    0x90, 0x4e, 0xfb, 0x97, 0x6d, 0x5f, 0xa8, 0x71, 0x11, 0xfc, 0xd1, 0x95, 0x81, 0xba, 0x8c, 0x1b,
    0x39, 0xfe, 0xa2, 0x15, 0xa6, 0x52, 0x4d, 0x5b, 0x59, 0xa5, 0xe0, 0x96, 0xd9, 0x8f, 0x7b, 0xed,
    0x29, 0xd3, 0x1f, 0x0e, 0xec, 0x23, 0x0f, 0xb8, 0x6c, 0x6f, 0x7d, 0x18, 0x46, 0xd6, 0xe4, 0xb5,
    0x9a, 0x79, 0x02, 0xf5, 0x03, 0xc0, 0x60, 0x66, 0x5c, 0x2f, 0x76, 0x85, 0x9d, 0x54, 0x1a, 0x6a,
    0x28, 0xce, 0x7f, 0x7c, 0x91, 0x99, 0x4c, 0x83, 0x3e, 0xb4, 0x1d, 0x05, 0xc1, 0xc3, 0xd7, 0x47,
    0xde, 0xbc, 0x62, 0x6e, 0x86, 0x14, 0x80, 0x77, 0xeb, 0xf3, 0x07, 0x31, 0x56, 0xd2, 0xc2, 0xc6,
    0x6b, 0xdc, 0xfd, 0x22, 0x92, 0xf0, 0x06, 0x51, 0x2d, 0x38, 0xe6, 0xa0, 0x25, 0xdf, 0xd5, 0x2c,
    0x1c, 0x94, 0x12, 0x9c, 0xb0, 0x9b, 0xc4, 0x0b, 0xc8, 0xd0, 0xf7, 0x30, 0xcb, 0x27, 0xfa, 0x7a,
    0x10, 0x61, 0xaa, 0xa4, 0x70, 0xb7, 0x2a, 0x5a, 0xc9, 0xf1, 0x0a, 0x49, 0x65, 0xee, 0x69, 0x4b,
    0x3a, 0x8d, 0x32, 0x5d, 0x68, 0xb9, 0x9f, 0x75, 0x19, 0x3f, 0xac, 0x37, 0x4f, 0xe7, 0x93, 0x89,
    0x7e, 0x4a, 0x3b, 0xea, 0x74, 0x72, 0x43, 0xbd, 0x24, 0xef, 0xb6, 0xff, 0x64, 0x58, 0x84, 0x8b,
    0xa7, 0xbb, 0xb2, 0xe1, 0x26, 0x2b, 0x50, 0xca, 0x21, 0xf9, 0x98, 0xa1, 0xe2, 0x42, 0x82, 0x48
];

const CMC42_ADDRESS_8_15_XOR2 = [
    0x9b, 0x9d, 0xc1, 0x3d, 0xa9, 0xb8, 0xf4, 0x6f, 0xf6, 0x25, 0xc7, 0x47, 0xd5, 0x97, 0xdf, 0x6b,
    0xeb, 0x90, 0xa4, 0xb2, 0x5d, 0xf5, 0x66, 0xb0, 0xb9, 0x8b, 0x93, 0x64, 0xec, 0x7b, 0x65, 0x8c,
    0xf1, 0x43, 0x42, 0x6e, 0x45, 0x9f, 0xb3, 0x35, 0x06, 0x71, 0x96, 0xdb, 0xa0, 0xfb, 0x0b, 0x3a,
    0x1f, 0xf8, 0x8e, 0x69, 0xcd, 0x26, 0xab, 0x86, 0xa2, 0x0c, 0xbd, 0x63, 0xa5, 0x7a, 0xe7, 0x6a,
    0x5f, 0x18, 0x9e, 0xbf, 0xad, 0x55, 0xb1, 0x1c, 0x5c, 0x03, 0x30, 0xc6, 0x37, 0x20, 0xe3, 0xc9,
    0x52, 0xe8, 0xee, 0x4f, 0x01, 0x70, 0xc4, 0x77, 0x29, 0x2a, 0xba, 0x53, 0x12, 0x04, 0x7d, 0xaf,
    0x33, 0x8f, 0xa8, 0x4d, 0xaa, 0x5b, 0xb4, 0x0f, 0x92, 0xbb, 0xed, 0xe1, 0x2f, 0x50, 0x6c, 0xd2,
    0x2c, 0x95, 0xd9, 0xf9, 0x98, 0xc3, 0x76, 0x4c, 0xf2, 0xe4, 0xe5, 0x2b, 0xef, 0x9c, 0x49, 0xb6,
    0x31, 0x3b, 0xbc, 0xa1, 0xca, 0xde, 0x62, 0x74, 0xea, 0x81, 0x00, 0xdd, 0xa6, 0x46, 0x88, 0x3f,
    0x39, 0xd6, 0x23, 0x54, 0x24, 0x4a, 0xd8, 0xdc, 0xd7, 0xd1, 0xcc, 0xbe, 0x57, 0x7c, 0xda, 0x44,
    0x61, 0xce, 0xd3, 0xd4, 0xe9, 0x28, 0x80, 0xe0, 0x56, 0x8a, 0x09, 0x05, 0x9a, 0x89, 0x1b, 0xf7,
    0xf3, 0x99, 0x6d, 0x5e, 0x48, 0x91, 0xc0, 0xd0, 0xc5, 0x79, 0x78, 0x41, 0x59, 0x21, 0x2e, 0xff,
    0xc2, 0x4b, 0x38, 0x83, 0x32, 0xe6, 0xe2, 0x7f, 0x1e, 0x17, 0x58, 0x1d, 0x1a, 0xfa, 0x85, 0x82,
    0x94, 0xc8, 0x72, 0x7e, 0xb7, 0xac, 0x0e, 0xfc, 0xfd, 0x16, 0x27, 0x75, 0x8d, 0xcb, 0x08, 0xfe,
    0x0a, 0x02, 0x0d, 0x36, 0x11, 0x22, 0x84, 0x40, 0x34, 0x3e, 0x2d, 0x68, 0x5a, 0xa7, 0x67, 0xae,
    0x87, 0x07, 0x10, 0x60, 0x14, 0x73, 0x3c, 0x51, 0x19, 0xa3, 0xb5, 0xcf, 0x13, 0xf0, 0x15, 0x4e
];

const CMC42_ADDRESS_16_23_XOR1 = [
    0x00, 0x5f, 0x03, 0x52, 0xce, 0xe3, 0x7d, 0x8f, 0x6b, 0xf8, 0x20, 0xde, 0x7b, 0x7e, 0x39, 0xbe,
    0xf5, 0x94, 0x18, 0x78, 0x80, 0xc9, 0x7f, 0x7a, 0x3e, 0x63, 0xf2, 0xe0, 0x4e, 0xf7, 0x87, 0x27,
    0x69, 0x6c, 0xa4, 0x1d, 0x85, 0x5b, 0xe6, 0x44, 0x25, 0x0c, 0x98, 0xc7, 0x01, 0x02, 0xa3, 0x26,
    0x09, 0x38, 0xdb, 0xc3, 0x1e, 0xcf, 0x23, 0x45, 0x68, 0x76, 0xd6, 0x22, 0x5d, 0x5a, 0xae, 0x16,
    0x9f, 0xa2, 0xb5, 0xcd, 0x81, 0xea, 0x5e, 0xb8, 0xb9, 0x9d, 0x9c, 0x1a, 0x0f, 0xff, 0xe1, 0xe7,
    0x74, 0xaa, 0xd4, 0xaf, 0xfc, 0xc6, 0x33, 0x29, 0x5c, 0xab, 0x95, 0xf0, 0x19, 0x47, 0x59, 0x67,
    0xf3, 0x96, 0x60, 0x1f, 0x62, 0x92, 0xbd, 0x89, 0xee, 0x28, 0x13, 0x06, 0xfe, 0xfa, 0x32, 0x6d,
    0x57, 0x3c, 0x54, 0x50, 0x2c, 0x58, 0x49, 0xfb, 0x17, 0xcc, 0xef, 0xb2, 0xb4, 0xf9, 0x07, 0x70,
    0xc5, 0xa9, 0xdf, 0xd5, 0x3b, 0x86, 0x2b, 0x0d, 0x6e, 0x4d, 0x0a, 0x90, 0x43, 0x31, 0xc1, 0xf6,
    0x88, 0x0b, 0xda, 0x53, 0x14, 0xdc, 0x75, 0x8e, 0xb0, 0xeb, 0x99, 0x46, 0xa1, 0x15, 0x71, 0xc8,
    0xe9, 0x3f, 0x4a, 0xd9, 0x73, 0xe5, 0x7c, 0x30, 0x77, 0xd3, 0xb3, 0x4b, 0x37, 0x72, 0xc2, 0x04,
    0x97, 0x08, 0x36, 0xb1, 0x3a, 0x61, 0xec, 0xe2, 0x1c, 0x9a, 0x8b, 0xd1, 0x1b, 0x2e, 0x9e, 0x8a,
    0xd8, 0x41, 0xe4, 0xc4, 0x40, 0x2f, 0xad, 0xc0, 0xb6, 0x84, 0x51, 0x66, 0xbb, 0x12, 0xe8, 0xdd,
    0xcb, 0xbc, 0x6f, 0xd0, 0x11, 0x83, 0x56, 0x4c, 0xca, 0xbf, 0x05, 0x10, 0xd7, 0xba, 0xfd, 0xed,
    0x8c, 0x0e, 0x4f, 0x3d, 0x35, 0x91, 0xb7, 0xac, 0x34, 0x64, 0x2a, 0xf1, 0x79, 0x6a, 0x9b, 0x2d,
    0x65, 0xf4, 0x42, 0xa0, 0x8d, 0xa7, 0x48, 0x55, 0x21, 0x93, 0x24, 0xd2, 0xa6, 0xa5, 0xa8, 0x82
];

const CMC42_ADDRESS_16_23_XOR2 = [
    0x29, 0x97, 0x1a, 0x2c, 0x0b, 0x94, 0x3e, 0x75, 0x01, 0x0d, 0x1b, 0xe1, 0x4d, 0x38, 0x39, 0x8f,
    0xe7, 0xd0, 0x60, 0x90, 0xb2, 0x0f, 0xbb, 0x70, 0x1f, 0xe6, 0x5b, 0x87, 0xb4, 0x43, 0xfd, 0xf5,
    0xf6, 0xf9, 0xad, 0xc0, 0x98, 0x17, 0x9f, 0x91, 0x15, 0x51, 0x55, 0x64, 0x6c, 0x18, 0x61, 0x0e,
    0xd9, 0x93, 0xab, 0xd6, 0x24, 0x2f, 0x6a, 0x3a, 0x22, 0xb1, 0x4f, 0xaa, 0x23, 0x48, 0xed, 0xb9,
    0x88, 0x8b, 0xa3, 0x6b, 0x26, 0x4c, 0xe8, 0x2d, 0x1c, 0x99, 0xbd, 0x5c, 0x58, 0x08, 0x50, 0xf2,
    0x2a, 0x62, 0xc1, 0x72, 0x66, 0x04, 0x10, 0x37, 0x6e, 0xfc, 0x44, 0xa9, 0xdf, 0xd4, 0x20, 0xdd,
    0xee, 0x41, 0xdb, 0x73, 0xde, 0x54, 0xec, 0xc9, 0xf3, 0x4b, 0x2e, 0xae, 0x5a, 0x4a, 0x5e, 0x47,
    0x07, 0x2b, 0x76, 0xa4, 0xe3, 0x28, 0xfe, 0xb0, 0xf0, 0x02, 0x06, 0xd1, 0xaf, 0x42, 0xc2, 0xa5,
    0xe0, 0x67, 0xbf, 0x16, 0x8e, 0x35, 0xce, 0x8a, 0xe5, 0x3d, 0x7b, 0x96, 0xd7, 0x79, 0x52, 0x1e,
    0xa1, 0xfb, 0x9b, 0xbe, 0x21, 0x9c, 0xe9, 0x56, 0x14, 0x7f, 0xa0, 0xe4, 0xc3, 0xc4, 0x46, 0xea,
    0xf7, 0xd2, 0x1d, 0x31, 0x0a, 0x5f, 0xeb, 0xa2, 0x68, 0x8d, 0xb5, 0xc5, 0x74, 0x0c, 0xdc, 0x82,
    0x80, 0x09, 0x19, 0x95, 0x71, 0x9a, 0x11, 0x57, 0x77, 0x4e, 0xc6, 0xff, 0x12, 0x03, 0xa7, 0xc7,
    0xf4, 0xc8, 0xb6, 0x7a, 0x59, 0x36, 0x3c, 0x53, 0xe2, 0x69, 0x8c, 0x25, 0x05, 0x45, 0x63, 0xf8,
    0x34, 0x89, 0x33, 0x3f, 0x85, 0x27, 0xbc, 0x65, 0xfa, 0xa8, 0x6d, 0x84, 0x5d, 0xba, 0x40, 0x32,
    0x30, 0xef, 0x83, 0x13, 0xa6, 0x78, 0xcc, 0x81, 0x9e, 0xda, 0xca, 0xd3, 0x7e, 0x9d, 0x6f, 0xcd,
    0xb7, 0xb3, 0xd8, 0xcf, 0x3b, 0x00, 0x92, 0xb8, 0x86, 0xac, 0x49, 0x7c, 0xf1, 0xd5, 0xcb, 0x7d
];

const CMC42_ADDRESS_0_7_XOR = [
    0x74, 0xad, 0x5d, 0x1d, 0x9e, 0xc3, 0xfa, 0x4e, 0xf7, 0xdb, 0xca, 0xa2, 0x64, 0x36, 0x56, 0x0c,
    0x4f, 0xcf, 0x43, 0x66, 0x1e, 0x91, 0xe3, 0xa5, 0x58, 0xc2, 0xc1, 0xd4, 0xb9, 0xdd, 0x76, 0x16,
    0xce, 0x61, 0x75, 0x01, 0x2b, 0x22, 0x38, 0x55, 0x50, 0xef, 0x6c, 0x99, 0x05, 0xe9, 0xe8, 0xe0,
    0x2d, 0xa4, 0x4b, 0x4a, 0x42, 0xae, 0xba, 0x8c, 0x6f, 0x93, 0x14, 0xbd, 0x71, 0x21, 0xb0, 0x02,
    0x15, 0xc4, 0xe6, 0x60, 0xd7, 0x44, 0xfd, 0x85, 0x7e, 0x78, 0x8f, 0x00, 0x81, 0xf1, 0xa7, 0x3b,
    0xa0, 0x10, 0xf4, 0x9f, 0x39, 0x88, 0x35, 0x62, 0xcb, 0x19, 0x31, 0x11, 0x51, 0xfb, 0x2a, 0x20,
    0x45, 0xd3, 0x7d, 0x92, 0x1b, 0xf2, 0x09, 0x0d, 0x97, 0xa9, 0xb5, 0x3c, 0xee, 0x5c, 0xaf, 0x7b,
    0xd2, 0x3a, 0x49, 0x8e, 0xb6, 0xcd, 0xd9, 0xde, 0x8a, 0x29, 0x6e, 0xd8, 0x0b, 0xe1, 0x69, 0x87,
    0x1a, 0x96, 0x18, 0xcc, 0xdf, 0xe7, 0xc5, 0xc7, 0xf8, 0x52, 0xc9, 0xf0, 0xb7, 0xe5, 0x33, 0xda,
    0x67, 0x9d, 0xa3, 0x03, 0x0e, 0x72, 0x26, 0x79, 0xe2, 0xb8, 0xfc, 0xaa, 0xfe, 0xb4, 0x86, 0xc8,
    0xd1, 0xbc, 0x12, 0x08, 0x77, 0xeb, 0x40, 0x8d, 0x04, 0x25, 0x4d, 0x5a, 0x6a, 0x7a, 0x2e, 0x41,
    0x65, 0x1c, 0x13, 0x94, 0xb2, 0x63, 0x28, 0x59, 0x5e, 0x9a, 0x30, 0x07, 0xc6, 0xbf, 0x17, 0xf5,
    0x0f, 0x89, 0xf3, 0x1f, 0xea, 0x6d, 0xb3, 0xc0, 0x70, 0x47, 0xf9, 0x53, 0xf6, 0xd6, 0x54, 0xed,
    0x6b, 0x4c, 0xe4, 0x8b, 0x83, 0x24, 0x90, 0xb1, 0x7c, 0xbb, 0x73, 0xab, 0xd5, 0x2f, 0x5f, 0xec,
    0x9c, 0x2c, 0xa8, 0x34, 0x46, 0x37, 0x27, 0xa1, 0x0a, 0x06, 0x80, 0x68, 0x82, 0x32, 0x84, 0xff,
    0x48, 0xac, 0x7f, 0x3f, 0x95, 0xdc, 0x98, 0x9b, 0xbe, 0x23, 0x57, 0x3e, 0x5b, 0xd0, 0x3d, 0xa6
];

function encrypt(src, dst, pos0, pos1,
                 table0hi, table0lo, table1, base, invert, address_0_7_xor)
{
    const tmp = table1[(base & 0xff) ^ address_0_7_xor[(base >> 8) & 0xff]];
    const xor0 = (table0hi[(base >> 8) & 0xff] & 0xfe) | (tmp & 0x01);
    const xor1 = (tmp & 0xfe) | (table0lo[(base >> 8) & 0xff] & 0x01);

    if (invert) {
	dst[pos1] = src[pos0] ^ xor0;
	dst[pos0] = src[pos1] ^ xor1;
    }
    else {
	dst[pos0] = src[pos0] ^ xor0;
	dst[pos1] = src[pos1] ^ xor1;
    }
}

function gfx_encrypt(rom, extra_xor,
                     type0_t03, type0_t12, type1_t03, type1_t12,
                     address_8_15_xor1, address_8_15_xor2,
                     address_16_23_xor1, address_16_23_xor2,
                     address_0_7_xor)
{
    const buf = Buffer.allocUnsafe(rom.length);

    for (let rpos = 0; rpos < rom.length/4; rpos++) {
        let baser = rpos;
        baser ^= extra_xor;
        baser ^= address_8_15_xor1[(baser >> 16) & 0xff] << 8;
        baser ^= address_8_15_xor2[baser & 0xff] << 8;
        baser ^= address_16_23_xor1[baser & 0xff] << 16;
        baser ^= address_16_23_xor2[(baser >> 8) & 0xff] << 16;
        baser ^= address_0_7_xor[(baser >> 8) & 0xff];
        baser &= (rom.length/4)-1;

        buf[4*baser+0] = rom[4*rpos+0];
        buf[4*baser+1] = rom[4*rpos+1];
        buf[4*baser+2] = rom[4*rpos+2];
        buf[4*baser+3] = rom[4*rpos+3];
    }

    for (let rpos = 0; rpos < rom.length/4; rpos++) {
        encrypt(buf, rom, 4*rpos+0, 4*rpos+3,
                type0_t03, type0_t12, type1_t03, rpos, (rpos>>8) & 1,
                address_0_7_xor);
        encrypt(buf, rom, 4*rpos+1, 4*rpos+2,
                type0_t12, type0_t03, type1_t12, rpos,
                ((rpos>>16) ^ address_16_23_xor2[(rpos>>8) & 0xff]) & 1,
                address_0_7_xor);
    }
}

function cmc42_gfx_encrypt(rom, extra_xor)
{
    gfx_encrypt(
        rom, extra_xor,
        CMC42_TYPE0_T03, CMC42_TYPE0_T12, CMC42_TYPE1_T03, CMC42_TYPE1_T12,
        CMC42_ADDRESS_8_15_XOR1, CMC42_ADDRESS_8_15_XOR2,
        CMC42_ADDRESS_16_23_XOR1, CMC42_ADDRESS_16_23_XOR2,
        CMC42_ADDRESS_0_7_XOR
    );
}

return {
    deoptimize_sprites: deoptimize_sprites,
    sfix_reorder:       sfix_reorder,
    MSLUG3_GFX_KEY:     MSLUG3_GFX_KEY,
    mslug3_encrypt_68k: mslug3_encrypt_68k,
    cmc42_gfx_encrypt:  cmc42_gfx_encrypt
};
})();

// from https://github.com/mamedev/mame/blob/32f4e130ee99038854786024acc3e0871a4f7d0c/src/mame/drivers/ddragon.cpp
// license:BSD-3-Clause
// copyright-holders:Philip Bennett,Carlos A. Lozano, Rob Rosenbrock, Phil Stroffolino, Ernesto Corvi, David Haywood, R. Belmont
const DDRAGON_CHAR_LAYOUT = {
    width: 8,
    height: 8,
    total: [1,1],
    planes: 4,
    planeoffset: [0, 2, 4, 6],
    xoffset: [1, 0, 8*8+1, 8*8+0, 16*8+1, 16*8+0, 24*8+1, 24*8+0],
    yoffset: [0*8, 1*8, 2*8, 3*8, 4*8, 5*8, 6*8, 7*8],
    charincrement: 32*8
};

const DDRAGON_TILE_LAYOUT = {
    width: 16,
    height: 16,
    total: [1,2],
    planes: 4,
    planeoffset: [[1,2,0], [1,2,4], 0, 4],
    xoffset: [3, 2, 1, 0, 16*8+3, 16*8+2, 16*8+1, 16*8+0,
	      32*8+3, 32*8+2, 32*8+1, 32*8+0, 48*8+3, 48*8+2, 48*8+1, 48*8+0],
    yoffset: [0*8, 1*8, 2*8, 3*8, 4*8, 5*8, 6*8, 7*8,
	      8*8, 9*8, 10*8, 11*8, 12*8, 13*8, 14*8, 15*8],
    charincrement: 64*8
};

// from https://github.com/mamedev/mame/blob/b888b8c4edaeccea889b97e1c2df6f914ae6e303/src/mame/drivers/ddragon3.cpp
// license:BSD-3-Clause
// copyright-holders:Bryan McPhail, David Haywood
const  WWF_TILE_LAYOUT = {
    width: 16,
    height: 16,
    total: [1,2],
    planes: 4,
    planeoffset: [8, 0, [1,2,8], [1,2,0]],
    xoffset: [0, 1, 2, 3, 4, 5, 6, 7,
              32*8+0, 32*8+1, 32*8+2, 32*8+3, 32*8+4, 32*8+5, 32*8+6, 32*8+7],
    yoffset: [0*16, 1*16, 2*16, 3*16, 4*16, 5*16, 6*16, 7*16,
	      16*8, 16*9, 16*10, 16*11, 16*12, 16*13, 16*14, 16*15],
    charincrement: 64*8
};

const WWF_SPRITE_LAYOUT = {
    width: 16,
    height: 16,
    total: [1,4],
    planes: 4,
    planeoffset: [[0,4], [1,4], [2,4], [3,4]],
    xoffset: [0, 1, 2, 3, 4, 5, 6, 7,
              16*8+0, 16*8+1, 16*8+2, 16*8+3, 16*8+4, 16*8+5, 16*8+6, 16*8+7],
    yoffset: [0*8, 1*8, 2*8, 3*8, 4*8, 5*8, 6*8, 7*8,
	      8*8, 9*8, 10*8, 11*8, 12*8, 13*8, 14*8, 15*8],
    charincrement: 32*8
};

// from https://github.com/mamedev/mame/blob/6c23897483a0201dd0b65b450253fd9bf8fb8723/src/mame/drivers/m72.cpp
// license:BSD-3-Clause
// copyright-holders:Nicola Salmoria
const M72_TILE_LAYOUT = {
    width: 8,
    height: 8,
    total: [1,4],
    planes: 4,
    planeoffset: [[3,4], [2,4], [1,4], [0,4]],
    xoffset: [0, 1, 2, 3, 4, 5, 6, 7],
    yoffset: [0*8, 1*8, 2*8, 3*8, 4*8, 5*8, 6*8, 7*8],
    charincrement: 8*8
};

const M72_SPRITE_LAYOUT = {
    width: 16,
    height: 16,
    total: [1,4],
    planes: 4,
    planeoffset: [[3,4], [2,4], [1,4], [0,4]],
    xoffset: [0, 1, 2, 3, 4, 5, 6, 7,
	      16*8+0, 16*8+1, 16*8+2, 16*8+3, 16*8+4, 16*8+5, 16*8+6, 16*8+7],
    yoffset: [0*8, 1*8, 2*8, 3*8, 4*8, 5*8, 6*8, 7*8,
	      8*8, 9*8, 10*8, 11*8, 12*8, 13*8, 14*8, 15*8],
    charincrement: 32*8
};

// from https://github.com/mamedev/mame/blob/27600407666e5222233ae298c88c9da181266937/src/mame/drivers/vigilant.cpp
// license:BSD-3-Clause
// copyright-holders:Mike Balfour
const VIGILANT_TEXT_LAYOUT = {
    width: 8,
    height: 8,
    total: [1,2],
    planes: 4,
    planeoffset: [[1,2], [1,2,4], 0, 4],
    xoffset: [0,1,2,3, 64+0,64+1,64+2,64+3],
    yoffset: [0*8, 1*8, 2*8, 3*8, 4*8, 5*8, 6*8, 7*8],
    charincrement: 128
};

const VIGILANT_SPRITE_LAYOUT = {
    width: 16,
    height: 16,
    total: [1,2],
    planes: 4,
    planeoffset: [[1,2], [1,2,4], 0, 4],
    xoffset: [
        0x00*8+0,0x00*8+1,0x00*8+2,0x00*8+3,
        0x10*8+0,0x10*8+1,0x10*8+2,0x10*8+3,
        0x20*8+0,0x20*8+1,0x20*8+2,0x20*8+3,
        0x30*8+0,0x30*8+1,0x30*8+2,0x30*8+3
    ],
    yoffset: [
        0x00*8, 0x01*8, 0x02*8, 0x03*8,
        0x04*8, 0x05*8, 0x06*8, 0x07*8,
        0x08*8, 0x09*8, 0x0A*8, 0x0B*8,
        0x0C*8, 0x0D*8, 0x0E*8, 0x0F*8
    ],
    charincrement: 0x40*8
};

const VIGILANT_BACK_LAYOUT = {
    width: 32,
    height: 1,
    total: [1,1],
    planes: 4,
    planeoffset: [0,2,4,6],
    xoffset: [
        0*8+1, 0*8,  1*8+1, 1*8, 2*8+1, 2*8, 3*8+1, 3*8, 4*8+1, 4*8, 5*8+1, 5*8,
        6*8+1,6*8, 7*8+1,7*8, 8*8+1,8*8, 9*8+1,9*8, 10*8+1,10*8, 11*8+1,11*8,
        12*8+1, 12*8, 13*8+1, 13*8, 14*8+1, 14*8, 15*8+1, 15*8
    ],
    yoffset: [0],
    charincrement: 16*8
};

// from https://github.com/mamedev/mame/blob/b888b8c4edaeccea889b97e1c2df6f914ae6e303/src/mame/drivers/raiden.cpp
// license:BSD-3-Clause
// copyright-holders:Bryan McPhail
// thanks-to:Oliver Bergmann,Randy Mongenel (for initial CPU core)
const RAIDEN_SPRITE_LAYOUT = {
    width: 16,
    height: 16,
    total: 4096,
    planes: 4,
    planeoffset: [12, 8, 4, 0],
    xoffset: [0,1,2,3, 16,17,18,19,
	      512+0,512+1,512+2,512+3, 512+8+8,512+9+8,512+10+8,512+11+8],
    yoffset: [0*32, 1*32, 2*32, 3*32, 4*32, 5*32, 6*32, 7*32,
	      8*32, 9*32, 10*32, 11*32, 12*32, 13*32, 14*32, 15*32],
    charincrement: 1024
};

// from https://github.com/mamedev/mame/blob/6c23897483a0201dd0b65b450253fd9bf8fb8723/src/mame/drivers/seibuspi.cpp
// license:BSD-3-Clause
// copyright-holders:Ville Linde, hap, Nicola Salmoria
const SPI_CHAR_LAYOUT = {
  width: 8,
  height: 8,
  total: 4096,
  planes: 6,
  planeoffset: [0, 4, 8, 12, 16, 20],
  xoffset: [3, 2, 1, 0, 27, 26, 25, 24],
  yoffset: [0*48, 1*48, 2*48, 3*48, 4*48, 5*48, 6*48, 7*48],
  charincrement: 6*8*8
};

const SPI_TILE_LAYOUT = {
  width: 16,
  height: 16,
  total: [1,1],
  planes: 6,
  planeoffset: [0, 4, 8, 12, 16, 20],
  xoffset: [3, 2, 1, 0,  27,26,25,24,  51,50,49,48,  75,74,73,72],
  yoffset: [0*96, 1*96, 2*96, 3*96, 4*96, 5*96, 6*96, 7*96,
            8*96, 9*96, 10*96, 11*96, 12*96, 13*96, 14*96, 15*96],
  charincrement: 6*16*16
};

const SPI_SPRITE_LAYOUT = {
    width: 16,
    height: 16,
    total: [1,3],
    planes: 6,
    planeoffset: [0,8,[1,3,0],[1,3,8],[2,3,0],[2,3,8]],
    xoffset: [7,6,5,4,3,2,1,0,23,22,21,20,19,18,17,16],
    yoffset: [0*32,1*32,2*32,3*32,4*32,5*32,6*32,7*32,
              8*32,9*32,10*32,11*32,12*32,13*32,14*32,15*32],
    charincrement: 16*32
};

function ddragon(srcdir)
{
    convert_roms('ddragon', srcdir, {
        maincpu: {
            input: 'ddragon_hd6309.bin',
            output: ['21j-1-5.26', '21j-2-3.25', '21j-3.24', '21j-4-1.23']
        },
        sub: { input: 'ddragon_hd63701.bin', output: '21jm-0.ic55' },
        soundcpu: { input: 'ddragon_m6809.bin', output: '21j-0-1' },
        gfx1: {
            input: {
                file: 'ddragon_gfxdata1.bin', layout: DDRAGON_CHAR_LAYOUT
            },
            output: '21j-5'
        },
        gfx2: {
            input: {
                file: 'ddragon_gfxdata2.bin', layout: DDRAGON_TILE_LAYOUT
            },
            output: ['21j-a', '21j-b', '21j-c', '21j-d',
                     '21j-e', '21j-f', '21j-g', '21j-h']
        },
        gfx3: {
            input: {
                file: 'ddragon_gfxdata3.bin', layout: DDRAGON_TILE_LAYOUT
            },
            output: ['21j-8', '21j-9', '21j-i', '21j-j']
        },
        adpcm: { input: 'ddragon_adpcm.bin', output: ['21j-6', '21j-7'] },
        proms: {
            input: 'proms.bin', output: ['21j-k-0', '21j-l-0'],
            transform: bin => split_at(bin, 0x100)
        }
    });
}

function ddragon2(srcdir)
{
    convert_roms('ddragon2', srcdir, {
        maincpu: {
            input: 'ddragon2_hd6309.bin',
            output: ['26a9-04.bin', '26aa-03.bin', '26ab-0.bin', '26ac-0e.63']
        },
        sub: { input: 'ddragon2_z80sub.bin', output: '26ae-0.bin' },
        soundcpu: { input: 'ddragon2_z80sound.bin', output: '26ad-0.bin' },
        gfx1: {
            input: {
                file: 'ddragon2_gfxdata1.bin', layout: DDRAGON_CHAR_LAYOUT
            },
            output: '26a8-0e.19'
        },
        gfx2: {
            input: {
                file: 'ddragon2_gfxdata2.bin', layout: DDRAGON_TILE_LAYOUT
            },
            output: ['26j0-0.bin', '26j1-0.bin', '26af-0.bin',
                     '26j2-0.bin', '26j3-0.bin', '26j10-0.bin']
        },
        gfx3: {
            input: {
                file: 'ddragon2_gfxdata3.bin', layout: DDRAGON_TILE_LAYOUT
            },
            output: ['26j4-0.bin', '26j5-0.bin']
        },
        oki: {
            input: 'ddragon2_oki.bin', output: ['26j6-0.bin', '26j7-0.bin']
        },
        proms: {
            input: 'proms.bin', output: 'prom.16',
            transform: bin => bin.slice(0x100)
        }
    });
}

function ddragon3_mame2000(srcdir)
{
    convert_roms('ddragon3', srcdir, {
        cpu1: {
            input: 'ddragon3_m68k.bin', output: ['30a14', '30a15'],
            transform: bin => {
                const a = interleave(bin);
                return [a[1], a[0].slice(0, 0x20000)];
            }
        },
        cpu2: { input: 'ddragon3_z80.bin', output: 'dd3.06' },
        gfx1: {
            input: { file: 'ddragon3_gfxdata1.bin', layout: WWF_TILE_LAYOUT },
            output: ['dd3.e', 'dd3.a', 'dd3.f', 'dd3.b'],
            transform: bin => interleave(bin).flatMap(b => split_at(b, 0x40000))
        },
        gfx2: {
            input: { file: 'ddragon3_gfxdata2.bin', layout: WWF_SPRITE_LAYOUT},
            output: ['dd3.3e', 'dd3.3d', 'dd3.3c', 'dd3.3b', 'dd3.3a',
                     'dd3.2e', 'dd3.2d', 'dd3.2c', 'dd3.2b', 'dd3.2a',
                     'dd3.1e', 'dd3.1d', 'dd3.1c', 'dd3.1b', 'dd3.1a',
                     'dd3.0e', 'dd3.0d', 'dd3.0c', 'dd3.0b', 'dd3.0a'],
            transform: bin =>
                split(bin, 0x90000).flatMap(b => split(b, 0x20000))
        },
        sound1: { input: 'ddragon3_oki.bin', output: ['dd3.j7', 'dd3.j8'] }
    });
}

function ddragon3(srcdir)
{
    convert_roms('ddragon3', srcdir, {
        maincpu: {
            input: 'ddragon3_m68k.bin',
            output: ['30a15-0.ic79', '30a14-0.ic78'],
            transform: bin => {
                const a = interleave(bin);
                return [a[0].slice(0, 0x20000), a[1]];
            }
        },
        audiocpu: { input: 'ddragon3_z80.bin', output: '30a13-0.ic43' },
        gfx1: {
            input: { file: 'ddragon3_gfxdata1.bin', layout: WWF_TILE_LAYOUT },
            output: ['30j-6.ic5', '30j-4.ic7', '30j-7.ic4', '30j-5.ic6'],
            transform: bin => interleave(bin).flatMap(b => split_at(b, 0x40000))
        },
        gfx2: {
            input: { file: 'ddragon3_gfxdata2.bin', layout: WWF_SPRITE_LAYOUT},
            output: ['30j-3.ic9',  '30a12-0.ic8',  '30j-2.ic11', '30a11-0.ic10',
                     '30j-1.ic13', '30a10-0.ic12', '30j-0.ic15', '30a9-0.ic14'],
            transform: bin =>
                split(bin, 0x90000).flatMap(b => split_at(b, 0x80000))
        },
        oki: { input: 'ddragon3_oki.bin', output: '30j-8.ic73' },
        // missing
        proms: { input: Buffer.alloc(0x100), output: 'mb7114h.ic38' }
    });
}

function rtype(srcdir)
{
    convert_roms('rtype', srcdir, {
        maincpu: {
            input: 'RTYPE_CPU.BIN',
            output: ['rt_r-l0-b.3b', 'rt_r-l1-b.3c',
                     'rt_r-h0-b.1b', 'rt_r-h1-b.1c'],
            transform: bin =>
                interleave(bin).flatMap(b => split(b, 0x10000).slice(0, 2))
        },
        sprites: {
            input: { file: 'RTYPE_GFXDATA1.BIN', layout: M72_SPRITE_LAYOUT },
            output: ['rt_r-00.1h', 'rt_r-01.1j', 'rt_r-10.1k', 'rt_r-11.1l',
                     'rt_r-20.3h', 'rt_r-21.3j', 'rt_r-30.3k', 'rt_r-31.3l'],
            transform: bin =>
                split(bin, 0x10000).map((b, i) =>
                                        i % 2 == 0 ? b : b.slice(0, 0x08000))
        },
        gfx2: {
            input: { file: 'RTYPE_GFXDATA2.BIN', layout: M72_TILE_LAYOUT },
            output: ['rt_b-a0.3c', 'rt_b-a1.3d', 'rt_b-a2.3a', 'rt_b-a3.3e']
        },
        gfx3: {
            input: { file: 'RTYPE_GFXDATA3.BIN', layout: M72_TILE_LAYOUT },
            output: ['rt_b-b0.3j', 'rt_b-b1.3k', 'rt_b-b2.3h', 'rt_b-b3.3f']
        }
    });
}

function rtype2(srcdir)
{
    convert_roms('rtype2', srcdir, {
        maincpu: {
            input: 'RTYPE2_CPU1.BIN',
            output: ['rt2-a-l0-d.60', 'rt2-a-l1-d.59',
                     'rt2-a-h0-d.54', 'rt2-a-h1-d.53'],
            transform: bin =>
                interleave(bin).flatMap(b => split(b, 0x20000).slice(0, 2))
        },
        soundcpu: { input: 'RTYPE2_CPU2.BIN', output: 'ic17.4f' },
        sprites: {
            input: 'RTYPE2_GFX1.BIN',
            output: ['ic31.6l', 'ic21.4l', 'ic32.6m', 'ic22.4m']
        },
        gfx2: {
            input: 'RTYPE2_GFX2.BIN',
            output: ['ic50.7s', 'ic51.7u', 'ic56.8s', 'ic57.8u',
                     'ic65.9r', 'ic66.9u', 'ic63.9m', 'ic64.9p']
        },
        samples: { input: 'RTYPE2_SAMPLES.BIN', output: 'ic14.4c' }
    });
}

function airduelm72(srcdir)
{
    convert_roms('airduelm72', srcdir, {
        maincpu: {
            input: 'AIRDUEL_CPU.BIN',
            output: ['ad-c-l0.bin', 'ad-c-l3.bin',
                     'ad-c-h0.bin', 'ad-c-h3.bin'],
            transform: bin =>
                interleave(bin.slice(0, 0x80000))
                .flatMap(b => split(b, 0x20000))
        },
        sprites: {
            input: 'AIRDUEL_GFX1.BIN',
            output: ['ad-00.bin', 'ad-10.bin', 'ad-20.bin', 'ad-30.bin']
        },
        gfx2: {
            input: 'AIRDUEL_GFX2.BIN',
            output: ['ad-a0.bin', 'ad-a1.bin', 'ad-a2.bin', 'ad-a3.bin']
        },
        gfx3: {
            input: 'AIRDUEL_GFX3.BIN',
            output: ['ad-b0.bin', 'ad-b1.bin', 'ad-b2.bin', 'ad-b3.bin']
        },
        samples: { input: 'AIRDUEL_SAMPLES.BIN', output: 'ad-v0.bin' }
    });
}

function bchopper(srcdir)
{
    convert_roms('bchopper', srcdir, {
        maincpu: {
            input: 'BCHOPPER_CPU.BIN',
            output: ['c-l0-b.rom', 'c-l1-b.rom', 'c-l3-b.rom',
                     'c-h0-b.rom', 'c-h1-b.rom', 'c-h3-b.rom'],
            transform: bin =>
                interleave(bin).flatMap(b => {
                    var a = split(b, 0x10000);
                    return [a[0], a[1], a[3]];
                })
        },
        sprites: {
            input: 'BCHOPPER_GFX1.BIN',
            output: ['c-00-a.rom', 'c-01-b.rom', 'c-10-a.rom', 'c-11-b.rom',
                     'c-20-a.rom', 'c-21-b.rom', 'c-30-a.rom', 'c-31-b.rom']
        },
        gfx2: {
            input: 'BCHOPPER_GFX2.BIN',
            output: ['b-a0-b.rom', 'b-a1-b.rom', 'b-a2-b.rom', 'b-a3-b.rom']
        },
        gfx3: {
            input: 'BCHOPPER_GFX3.BIN',
            output: ['b-b0-.rom', 'b-b1-.rom', 'b-b2-.rom', 'b-b3-.rom']
        },
        samples: { input: 'BCHOPPER_SAMPLES.BIN', output: 'c-v0-b.rom' }
    });
}

function bmaster(srcdir)
{
    convert_roms('bmaster', srcdir, {
        maincpu: {
            input: 'BMASTER_CPU1.BIN',
            output: ['bm_d-l0-b.5f', 'bm_d-l1-b.5j',
                     'bm_d-h0-b.5m', 'bm_d-h1-b.5l'],
            transform: bin =>
                interleave(bin.slice(0, 0xa0000)).flatMap(b => {
                    return split_at(b, 0x40000);
                })
        },
        soundcpu: {
            input: 'BMASTER_CPU2.BIN',
            output: ['bm_d-sl0.rom', 'bm_d-sh0.rom'],
            transform: interleave
        },
        gfx1: {
            input: 'BMASTER_GFX1.BIN',
            output: ['bm_c0.rom', 'bm_c1.rom',
                     'bm_c2.rom', 'bm_c3.rom']
        },
        gfx2: {
            input: 'BMASTER_GFX2.BIN',
            output: ['bm_000.rom', 'bm_010.rom',
                     'bm_020.rom', 'bm_030.rom']
        },
        irem: { input: 'BMASTER_SOUND.BIN', output: 'bm_da.rom' }
    });
}

function cosmccop(srcdir)
{
    convert_roms('cosmccop', srcdir, {
        maincpu: {
            input: 'COSMCCOP_CPU1.BIN',
            output: ['cc-d-l0b.bin', 'cc-d-h0b.bin'],
            transform: bin => interleave(bin.slice(0, 0x80000))
        },
        soundcpu: { input: 'COSMCCOP_CPU2.BIN', output: 'cc-d-sp.bin' },
        sprites: {
            input: 'COSMCCOP_GFX1.BIN',
            output: ['cc-c-00.bin', 'cc-c-10.bin', 'cc-c-20.bin', 'cc-c-30.bin']
        },
        gfx2: {
            input: 'COSMCCOP_GFX2.BIN',
            output: ['cc-d-g00.bin', 'cc-d-g10.bin',
                     'cc-d-g20.bin', 'cc-d-g30.bin']
        },
        samples: { input: 'COSMCCOP_SAMPLES.BIN', output: 'cc-c-v0.bin' }
    });
}

function dbreedm72(srcdir)
{
    convert_roms('dbreedm72', srcdir, {
        maincpu: {
            input: 'DBREED72_CPU.BIN',
            output: ['db_c-l3.rom', 'db_c-l0.rom',
                     'db_c-h3.rom', 'db_c-h0.rom'],
            transform: bin =>
                interleave(bin).flatMap(b => {
                    return [b.slice(0, 0x20000), b.slice(0x30000, 0x40000)]
                })
        },
        sprites: {
            input: 'DBREED72_GFX1.BIN',
            output: ['db_k800m.00', 'db_k801m.10', 'db_k802m.20', 'db_k803m.30']
        },
        gfx2: {
            input: 'DBREED72_GFX2.BIN',
            output: ['db_k804m.a0', 'db_k805m.a1', 'db_k806m.a2', 'db_k807m.a3']
        },
        gfx3: {
            input: 'DBREED72_GFX3.BIN',
            output: ['db_k804m.b0', 'db_k805m.b1', 'db_k806m.b2', 'db_k807m.b3']
        },
        samples: { input: 'DBREED72_SAMPLES.BIN', output: 'db_c-v0.rom' }
    });
}

function gunforce(srcdir)
{
    convert_roms('gunforce', srcdir, {
        maincpu: {
            input: 'GUNFORCE_CPU1.BIN',
            output: ['gf_l0-c.5f', 'gf_l1-c.5j',
                     'gf_h0-c.5m', 'gf_h1-c.5l'],
            transform: bin =>
                interleave(bin.slice(0, 0x80000)).flatMap(b => {
                    return split_at(b, 0x20000);
                })
        },
        soundcpu: {
            input: 'GUNFORCE_CPU2.BIN',
            output: ['gf_sl0.rom', 'gf_sh0.rom'],
            transform: bin => interleave(bin.slice(0, 0x20000))
        },
        gfx1: {
            input: 'GUNFORCE_GFX1.BIN',
            output: ['gf_c0.rom', 'gf_c1.rom',
                     'gf_c2.rom', 'gf_c3.rom']
        },
        gfx2: {
            input: 'GUNFORCE_GFX2.BIN',
            output: ['gf_000.rom', 'gf_010.rom',
                     'gf_020.rom', 'gf_030.rom']
        },
        irem: { input: 'GUNFORCE_SOUND.BIN', output: 'gf-da.rom' }
    });
}

function gunforc2(srcdir)
{
    convert_roms('gunforc2', srcdir, {
        maincpu: {
            input: 'GUNFORC2_CPU1.BIN',
            output: ['a2-l0-a.8h', 'a2-l1-a.8f',
                     'a2-h0-a.6h', 'a2-h1-a.6f'],
            transform: bin =>
                interleave(bin).flatMap(b => {
                    return [b.slice(0, 0x40000), b.slice(0x80000, 0xc0000)];
                })
        },
        soundcpu: {
            input: 'GUNFORC2_CPU2.BIN',
            output: ['a2_sl0.5l', 'a2_sh0.3l'],
            transform: bin => interleave(bin.slice(0, 0x20000))
        },
        gfx1: {
            input: 'GUNFORC2_GFX1.BIN',
            output: ['a2_c0.1a', 'a2_c1.1b',
                     'a2_c2.3a', 'a2_c3.3b']
        },
        gfx2: {
            input: 'GUNFORC2_GFX2.BIN',
            output: ['a2_000.8a', 'a2_010.8b',
                     'a2_020.8c', 'a2_030.8d']
        },
        irem: { input: 'GUNFORC2_SOUND.BIN', output: 'a2_da.1l' }
    });
}

function hharry(srcdir)
{
    convert_roms('hharry', srcdir, {
        maincpu: {
            input: 'HHARRY_CPU1.BIN',
            output: ['a-l0-v.rom', 'a-l1-0.rom', 'a-h0-v.rom', 'a-h1-0.rom'],
            transform: bin =>
                interleave(bin).flatMap(b => {
                    return [b.slice(0, 0x20000), b.slice(0x30000, 0x40000)]
                })
        },
        soundcpu: { input: 'HHARRY_CPU2.BIN', output: 'a-sp-0.rom' },
        sprites: {
            input: 'HHARRY_GFX1.BIN',
            output: ['hh_00.rom', 'hh_10.rom', 'hh_20.rom', 'hh_30.rom']
        },
        gfx2: {
            input: 'HHARRY_GFX2.BIN',
            output: ['hh_a0.rom', 'hh_a1.rom',
                     'hh_a2.rom', 'hh_a3.rom']
        },
        samples: { input: 'HHARRY_SAMPLES.BIN', output: 'a-v0-0.rom' }
    });
}

function imgfight(srcdir)
{
    convert_roms('imgfight', srcdir, {
        maincpu: {
            input: 'IMGFIGHT_CPU.BIN',
            output: ['if-c-l0-a.bin', 'if-c-l3.bin',
                     'if-c-h0-a.bin', 'if-c-h3.bin'],
            transform: bin =>
                interleave(bin).flatMap(b => {
                    return [b.slice(0, 0x10000), b.slice(0x20000, 0x40000)]
                })
        },
        sprites: {
            input: 'IMGFIGHT_GFX1.BIN',
            output: ['if-c-00.bin', 'if-c-10.bin', 'if-c-20.bin', 'if-c-30.bin']
        },
        gfx2: {
            input: 'IMGFIGHT_GFX2.BIN',
            output: ['if-a-a0.bin', 'if-a-a1.bin', 'if-a-a2.bin', 'if-a-a3.bin']
        },
        gfx3: {
            input: 'IMGFIGHT_GFX3.BIN',
            output: ['if-a-b0.bin', 'if-a-b1.bin', 'if-a-b2.bin', 'if-a-b3.bin']
        },
        samples: {
            input: 'IMGFIGHT_SAMPLES.BIN',
            output: ['if-c-v0.bin', 'if-c-v1.bin']
        }
    });
}

function inthunt(srcdir)
{
    convert_roms('inthunt', srcdir, {
        maincpu: {
            input: 'INTHUNT_CPU1.BIN',
            output: ['ith-l0-d.bin', 'ith-l1-b.bin',
                     'ith-h0-d.bin', 'ith-h1-b.bin'],
            transform: bin =>
                interleave(bin.slice(0, 0xc0000)).flatMap(b => {
                    return split_at(b, 0x40000);
                })
        },
        soundcpu: {
            input: 'INTHUNT_CPU2.BIN',
            output: ['ith-sl0.rom', 'ith-sh0.rom'],
            transform: interleave
        },
        gfx1: {
            input: 'INTHUNT_GFX1.BIN',
            output: ['ith_ic26.rom', 'ith_ic25.rom',
                     'ith_ic24.rom', 'ith_ic23.rom']
        },
        gfx2: {
            input: 'INTHUNT_GFX2.BIN',
            output: ['ith_ic34.rom', 'ith_ic35.rom',
                     'ith_ic36.rom', 'ith_ic37.rom']
        },
        irem: { input: 'INTHUNT_SOUND.BIN', output: 'ith_ic9.rom' }
    });
}

function kungfum(srcdir)
{
    convert_roms('kungfum', srcdir, {
        maincpu: {
            input: 'KUNGFUM_Z80.BIN',
            output: ['a-4e-c.bin', 'a-4d-c.bin']
        },
        irem_audio: {
            input: 'KUNGFUM_M6803.BIN',
            output: ['a-3e-.bin', 'a-3f-.bin', 'a-3h-.bin']
        },
        gfx1: {
            input: 'KUNGFUM_GFX1.BIN',
            output: ['g-4c-a.bin', 'g-4d-a.bin', 'g-4e-a.bin']
        },
        gfx2: {
            input: 'KUNGFUM_GFX2.BIN',
            output: ['b-4k-.bin', 'b-4f-.bin', 'b-4l-.bin', 'b-4h-.bin',
                     'b-3n-.bin', 'b-4n-.bin', 'b-4m-.bin', 'b-3m-.bin',
                     'b-4c-.bin', 'b-4e-.bin', 'b-4d-.bin', 'b-4a-.bin']
        },
        spr_height_prom: { input: 'KUNGFUM_SPRH.BIN', output: 'b-5f-.bin' },
        color_proms: {
            input: 'KUNGFUM_PAL.BIN',
            output: ['g-1j-.bin', 'b-1m-.bin',
                     'g-1f-.bin', 'b-1n-.bin',
                     'g-1h-.bin', 'b-1l-.bin']
        },
        // missing
        timing: { input: Buffer.alloc(0x100), output: 'b-6f-.bin' }
   });
}

function loht(srcdir)
{
    convert_roms('loht', srcdir, {
        maincpu: {
            input: 'LOHT_CPU.BIN',
            output: ['tom_c-l0.rom', 'tom_c-l3-',
                     'tom_c-h0.rom', 'tom_c-h3-'],
            transform: bin =>
                interleave(bin.slice(0, 0x80000)).flatMap(b => {
                    return split_at(b, 0x20000);
                })
        },
        sprites: {
            input: 'LOHT_GFX1.BIN',
            output: ['tom_m53.rom', 'tom_m51.rom', 'tom_m49.rom', 'tom_m47.rom']
        },
        gfx2: {
            input: 'LOHT_GFX2.BIN',
            output: ['tom_m21.rom', 'tom_m22.rom', 'tom_m20.rom', 'tom_m23.rom']
        },
        gfx3: {
            input: 'LOHT_GFX3.BIN',
            output: ['tom_m26.rom', 'tom_m27.rom', 'tom_m25.rom', 'tom_m24.rom']
        },
        samples: { input: 'LOHT_SAMPLES.BIN', output: 'tom_m44.rom' }
    });
}

function mysticri(srcdir)
{
    convert_roms('mysticri', srcdir, {
        maincpu: {
            input: 'MYSTICRI_CPU1.BIN',
            output: ['mr-l0-b.bin', 'mr-l1-b.bin',
                     'mr-h0-b.bin', 'mr-h1-b.bin'],
            transform: bin =>
                interleave(bin.slice(0, 0xa0000)).flatMap(b => {
                    return split_at(b, 0x40000);
                })
        },
        soundcpu: {
            input: 'MYSTICRI_CPU2.BIN',
            output: ['mr-sl0.bin', 'mr-sh0.bin'],
            transform: bin => interleave(bin.slice(0, 0x20000))
        },
        gfx1: {
            input: 'MYSTICRI_GFX1.BIN',
            output: ['mr-c0.bin', 'mr-c1.bin',
                     'mr-c2.bin', 'mr-c3.bin']
        },
        gfx2: {
            input: 'MYSTICRI_GFX2.BIN',
            output: ['mr-o00.bin', 'mr-o10.bin',
                     'mr-o20.bin', 'mr-o30.bin'],
            transform: bin => {
                var a = split(bin, 0x80000);
                return [a[0], a[2], a[4], a[6]];
            }
        },
        irem: { input: 'MYSTICRI_SOUND.BIN', output: 'mr-da.bin' }
    });
}

function nspirit_mame2010(srcdir)
{
    convert_roms('nspirit', srcdir, {
        maincpu: {
            input: 'NSPIRIT_CPU.BIN',
            output: ['nin-c-l0.rom', 'nin-c-l1.rom',
                     'nin-c-l2.rom', 'nin-c-l3.rom',
                     'nin-c-h0.rom', 'nin-c-h1.rom',
                     'nin-c-h2.rom', 'nin-c-h3.rom'],
            transform: bin =>
                interleave(bin.slice(0, 0x80000)).flatMap(b => {
                    return split(b, 0x10000);
                })
        },
        gfx1: {
            input: 'NSPIRIT_GFX1.BIN',
            output: ['nin-r00.rom', 'nin-r10.rom', 'nin-r20.rom', 'nin-r30.rom']
        },
        gfx2: {
            input: 'NSPIRIT_GFX2.BIN',
            output: ['nin-b-a0.rom', 'nin-b-a1.rom',
                     'nin-b-a2.rom', 'nin-b-a3.rom']
        },
        gfx3: {
            input: 'NSPIRIT_GFX3.BIN',
            output: ['nin-b0.rom', 'nin-b1.rom',
                     'nin-b2.rom', 'nin-b3.rom']
        },
        samples: { input: 'NSPIRIT_SAMPLES.BIN', output: 'nin-v0.rom' }
    });
}

function nspirit(srcdir)
{
    convert_roms('nspirit', srcdir, {
        maincpu: {
            input: 'NSPIRIT_CPU.BIN',
            output: ['nin_c-l0.6d', 'nin_c-l1.6c',
                     'nin_c-l2.6b', 'nin_c-l3.6a',
                     'nin_c-h0.6h', 'nin_c-h1.6j',
                     'nin_c-h2.6l', 'nin_c-h3.6m'],
            transform: bin =>
                interleave(bin.slice(0, 0x80000)).flatMap(b => {
                    return split(b, 0x10000);
                })
        },
        sprites: {
            input: 'NSPIRIT_GFX1.BIN',
            output: ['nin-r00.7m', 'nin-r10.7j', 'nin-r20.7f', 'nin-r30.7d']
        },
        gfx2: {
            input: 'NSPIRIT_GFX2.BIN',
            output: ['nin_b-a0.4c', 'nin_b-a1.4d',
                     'nin_b-a2.4b', 'nin_b-a3.4e']
        },
        gfx3: {
            input: 'NSPIRIT_GFX3.BIN',
            output: ['b0.4j', 'b1.4k', 'b2.4h', 'b3.4f']
        },
        samples: { input: 'NSPIRIT_SAMPLES.BIN', output: 'nin-v0.7a' },
        // missing
        proms: {
            input: Buffer.alloc(0x100 * 2),
            output: [ 'm72_a-8l.8l', 'm72_a-9l.9l' ]
        },
        plds: {
            input: Buffer.alloc(0x100 * 3),
            output: ['nin_c-3f.3f', 'm72_a-3d.3d', 'm72_a-4d.4d']
        }
    });
}

function rtypeleo(srcdir)
{
    convert_roms('rtypeleo', srcdir, {
        maincpu: {
            input: 'RTYPELEO_CPU1.BIN',
            output: ['rtl-l0-c.bin', 'rtl-l1-d.bin',
                     'rtl-h0-c.bin', 'rtl-h1-d.bin'],
            transform: bin =>
                interleave(bin.slice(0, 0xc0000)).flatMap(b => {
                    return split_at(b, 0x40000);
                })
        },
        soundcpu: {
            input: 'RTYPELEO_CPU2.BIN',
            output: ['rtl-sl0a.bin', 'rtl-sh0a.bin'],
            transform: interleave
        },
        gfx1: {
            input: 'RTYPELEO_GFX1.BIN',
            output: ['rtl-c0.bin', 'rtl-c1.bin',
                     'rtl-c2.bin', 'rtl-c3.bin']
        },
        gfx2: {
            input: 'RTYPELEO_GFX2.BIN',
            output: ['rtl-000.bin', 'rtl-010.bin',
                     'rtl-020.bin', 'rtl-030.bin']
        },
        irem: { input: 'RTYPELEO_SOUND.BIN', output: 'rtl-da.bin' }
    });
}

function ssoldier(srcdir)
{
    convert_roms('ssoldier', srcdir, {
        maincpu: {
            input: 'SSOLDIER_CPU1.BIN',
            output: ['f3-l0-h.bin', 'f3-l1-a.bin',
                     'f3-h0-h.bin', 'f3-h1-a.bin'],
            transform: bin =>
                interleave(bin.slice(0, 0xc0000)).flatMap(b => {
                    return split_at(b, 0x40000);
                })
        },
        soundcpu: {
            input: 'SSOLDIER_CPU2.BIN',
            output: ['f3_sl0.sl0', 'f3_sh0.sh0'],
            transform: interleave
        },
        gfx1: {
            input: 'SSOLDIER_GFX1.BIN',
            output: ['f3_w50.c0', 'f3_w51.c1',
                     'f3_w52.c2', 'f3_w53.c3'],
            transform: bin => split(bin, 0x80000).map(b => b.slice(0, 0x40000))
        },
        gfx2: {
            input: 'SSOLDIER_GFX2.BIN',
            output: ['f3_w38.001', 'f3_w40.011',
                     'f3_w42.021', 'f3_w44.031',
                     'f3_w37.000', 'f3_w39.010',
                     'f3_w41.020', 'f3_w43.030'],
            transform: bin => interleave(bin).flatMap(b => split(b, 0x100000))
        },
        irem: { input: 'SSOLDIER_SOUND.BIN', output: 'f3_w95.da' }
    });
}

function uccops(srcdir)
{
    convert_roms('uccops', srcdir, {
        maincpu: {
            input: 'UCCOPS_CPU1.BIN',
            output: ['uc_l0.rom', 'uc_l1.rom',
                     'uc_h0.rom', 'uc_h1.rom'],
            transform: bin =>
                interleave(bin.slice(0, 0xc0000)).flatMap(b => {
                    return split_at(b, 0x40000);
                })
        },
        soundcpu: {
            input: 'UCCOPS_CPU2.BIN',
            output: ['uc_sl0.rom', 'uc_sh0.rom'],
            transform: interleave
        },
        gfx1: {
            input: 'UCCOPS_GFX1.BIN',
            output: ['uc_w38m.rom', 'uc_w39m.rom',
                     'uc_w40m.rom', 'uc_w41m.rom']
        },
        gfx2: {
            input: 'UCCOPS_GFX2.BIN',
            output: ['uc_k16m.rom', 'uc_k17m.rom',
                     'uc_k18m.rom', 'uc_k19m.rom']
        },
        irem: { input: 'UCCOPS_SOUND.BIN', output: 'uc_w42.rom' }
    });
}

function vigilant_mame2003(srcdir)
{
    convert_roms('vigilant', srcdir, {
        cpu1: {
            input: 'VIGILANT_CPU1.BIN',
            output: ['g07_c03.bin', 'j07_c04.bin'],
            transform: bin =>
                [bin.slice(0, 0x08000), bin.slice(0x10000, 0x20000)]
        },
        cpu2: { input: 'VIGILANT_CPU2.BIN', output: 'g05_c02.bin' },
        gfx1: {
            input: { file: 'VIGILANT_GFX1.BIN', layout: VIGILANT_TEXT_LAYOUT },
            output: ['f05_c08.bin', 'h05_c09.bin']
        },
        gfx2: {
            input: {
                file: 'VIGILANT_GFX2.BIN', layout: VIGILANT_SPRITE_LAYOUT
            },
            output: ['n07_c12.bin', 'k07_c10.bin',
                     'o07_c13.bin', 'l07_c11.bin',
                     't07_c16.bin', 'p07_c14.bin',
                     'v07_c17.bin', 's07_c15.bin']
        },
        gfx3: {
            input: 'VIGILANT_GFX_BG.BIN',
            output: ['d01_c05.bin', 'e01_c06.bin', 'f01_c07.bin'],
            transform: bin =>
                encode_gfx(vigilant_reorder(bin), VIGILANT_BACK_LAYOUT)
                .slice(0, 0x30000)
        },
        sound1: { input: 'VIGILANT_SAMPLES.BIN', output: 'd04_c01.bin' }
    });
}

function vigilantbl(srcdir)
{
    convert_roms('vigilantbl', srcdir, {
        maincpu: {
            input: 'VIGILANT_CPU1.BIN',
            output: ['g07_c03.bin', 'j07_c04.bin'],
            transform: bin =>
                [bin.slice(0, 0x08000), bin.slice(0x10000, 0x20000)]
        },
        soundcpu: { input: 'VIGILANT_CPU2.BIN', output: 'g05_c02.bin' },
        gfx1: {
            input: { file: 'VIGILANT_GFX1.BIN', layout: VIGILANT_TEXT_LAYOUT },
            output: ['f05_c08.bin', 'h05_c09.bin']
        },
        gfx2: {
            input: {
                file: 'VIGILANT_GFX2.BIN', layout: VIGILANT_SPRITE_LAYOUT
            },
            output: ['n07_c12.bin', 'k07_c10.bin',
                     'o07_c13.bin', 'l07_c11.bin',
                     't07_c16.bin', 'p07_c14.bin',
                     'v07_c17.bin', 's07_c15.bin']
        },
        gfx3: {
            input: 'VIGILANT_GFX_BG.BIN',
            output: ['d01_c05.bin', 'e01_c06.bin', 'f01_c07.bin'],
            transform: bin =>
                encode_gfx(vigilant_reorder(bin), VIGILANT_BACK_LAYOUT)
                .slice(0, 0x30000)
        },
        samples: { input: 'VIGILANT_SAMPLES.BIN', output: 'd04_c01.bin' },
        // missing
        plds: {
            input: Buffer.alloc(0x117 * 3),
            output: ['VG_B-8R.ic90', 'VG_B-4M.ic38', 'VG_B-1B.ic1']
        }
    });
}

function raidenb(srcdir)
{
    convert_roms('raidenb', srcdir, {
        maincpu: {
            input: 'raiden_maincpu.bin',
            output: ['1.u0253', '3__(raidenb).u022',
                     '2.u0252', '4__(raidenb).u023'],
            transform: bin => interleave(bin).flatMap(b => split_at(b, 0x10000))
        },
        sub: {
            input: 'raiden_subcpu.bin',
            output: ['5__(raidenb).u042', '6__(raidenb).u043'],
            transform: interleave
        },
        audiocpu: {
            input: 'raiden_audiocpu.bin',
            output: 'rai6.u212',
            transform: bin => {
                const a = split(bin, 0x8000);
                return Buffer.concat([a[0], a[2]]);
            }
        },
        gfx1: {
            input: 'raiden_gfx1.bin',
            output: ['9', '10']
        },
        gfx2: {
            input: {
                file: 'raiden_gfxdata2.bin', layout: RAIDEN_SPRITE_LAYOUT
            },
            output: 'sei420'
        },
        gfx3: {
            input: {
                file: 'raiden_gfxdata3.bin', layout: RAIDEN_SPRITE_LAYOUT
            },
            output: 'sei430'
        },
        gfx4: {
            input: {
                file: 'raiden_gfxdata4.bin', layout: RAIDEN_SPRITE_LAYOUT
            },
            output: 'sei440'
        },
        oki: { input: 'raiden_okim6295.bin', output: '7.u203' }
    });
}

function rdftj(srcdir)
{
    convert_roms('rdftj', srcdir, {
        maincpu: {
            input: 'rdft_i386.bin',
            output: ['gd_1.211', 'gd_2.212', 'gd_3.210', 'gd_4.29'],
            transform: bin => interleave(bin, [1,1,1,1])
        },
        gfx1: { // wrong checksums
            input: { file: 'rdft_gfxdata1.bin', layout: SPI_CHAR_LAYOUT },
            output: ['gd_5.423', 'gd_6.424', 'gd_7.48'],
            transform: bin => {
                SPI.seibuspi_text_encrypt(bin);
                return interleave(bin, [1,1,1]);
            }
        },
        gfx2: {
            input: { file: 'rdft_gfxdata2.bin', layout: SPI_TILE_LAYOUT },
            output: ['gd_bg1-d.415', 'gd_bg2-d.416',
                     'gd_bg1-p.410', 'gd_bg2-p.49'],
            transform: bin => {
                SPI.seibuspi_bg_encrypt(bin);
                return interleave(bin, [2,1])
                    .flatMap(b => split_at(b, b.length/2));
            }
        },
        gfx3: {
            input: { file: 'rdft_gfxdata3.bin', layout: SPI_SPRITE_LAYOUT },
            output: ['gd_obj-1.322', 'gd_obj-2.324', 'gd_obj-3.323'],
            transform: SPI.seibuspi_sprite_encrypt
        },
        sound01: {
            input: 'rdft_soundrom.bin',
            output: ['gd_pcm.217', 'gd_8.216'],
            transform: bin => split_at(bin, 0x200000)
        },
        soundflash1: {
            input: Buffer.alloc(0x100000, 0xff),
            output: 'flash0_blank_region01.u1053',
            transform: bin => { bin[0] = 0x01; return bin; }
        }
    });
}

function rdft2(srcdir)
{
    convert_roms('rdft2', srcdir, {
        maincpu: {
            input: 'rdft2_i386.bin',
            output: ['prg0.tun', 'prg1.bin', 'prg2.bin', 'prg3.bin'],
            transform: bin => interleave(bin, [1,1,1,1])
        },
        gfx1: { // wrong checksums
            input: { file: 'rdft2_gfxdata1.bin', layout: SPI_CHAR_LAYOUT },
            output: ['fix1.u0518', 'fix0.u0524', 'fixp.u0514'],
            transform: bin => {
                SPI.rdft2_text_encrypt(bin);
                return interleave(bin, [1,1,1]);
            }
        },
        gfx2: {
            input: { file: 'rdft2_gfxdata2.bin', layout: SPI_TILE_LAYOUT },
            output: ['bg-1d.u0535', 'bg-2d.u0536',
                     'bg-1p.u0537', 'bg-2p.u0538'],
            transform: bin => {
                SPI.rdft2_bg_encrypt(bin);
                return interleave(bin, [2,1])
                    .flatMap(b => split_at(b, b.length/2));
            }
        },
        gfx3: {
            input: { file: 'rdft2_gfxdata3.bin', layout: SPI_SPRITE_LAYOUT },
            output: ['obj3.u0434', 'obj3b.u0433', 'obj1.u0429',
                     'obj1b.u0430', 'obj2.u0431', 'obj2b.u0432'],
            transform: bin => {
                SPI.seibuspi_rise10_sprite_encrypt(bin);
                return split(bin, 0x600000).flatMap(b => split_at(b, 0x400000));
            }
        },
        sound01: {
            input: 'rdft2_soundrom.bin',
            output: ['pcm.u0217', 'sound1.u0222'],
            transform: bin => split_at(bin, 0x200000)
        },
        soundflash1: {
            input: Buffer.alloc(0x100000, 0xff),
            output: 'flash0_blank_region80.u1053',
            transform: bin => { bin[0] = 0x80; return bin; }
        }
    });
}

function rfjet(srcdir)
{
    convert_roms('rfjet', srcdir, {
        maincpu: {
            input: 'rfjet_i386.bin',
            output: ['prg0.u0211', 'prg1.u0212', 'prg2.u0221', 'prg3.u0220'],
            transform: bin => interleave(bin, [1,1,1,1])
        },
        gfx1: { // wrong checksums
            input: { file: 'rfjet_gfxdata1.bin', layout: SPI_CHAR_LAYOUT },
            output: ['fix1.u0518', 'fix0.u0524', 'fixp.u0514'],
            transform: bin => {
                SPI.rfjet_text_encrypt(bin);
                return interleave(bin, [1,1,1]);
            }
        },
        gfx2: {
            input: { file: 'rfjet_gfxdata2.bin', layout: SPI_TILE_LAYOUT },
            output: ['bg-1d.u0543', 'bg-2d.u0545',
                     'bg-1p.u0544', 'bg-2p.u0546'],
            transform: bin => {
                SPI.rfjet_bg_encrypt(bin);
                return interleave(bin, [2,1])
                    .flatMap(b => split_at(b, b.length*2/3));
            }
        },
        gfx3: {
            input: { file: 'rfjet_gfxdata3.bin', layout: SPI_SPRITE_LAYOUT },
            output: ['obj-1.u0442', 'obj-2.u0443', 'obj-3.u0444'],
            transform: bin => SPI.seibuspi_rise11_sprite_encrypt_rfjet(bin)
        },
        sound01: {
            input: 'rfjet_soundrom.bin',
            output: ['pcm-d.u0227', 'sound1.u0222'],
            transform: bin => split_at(bin, 0x200000)
        },
        soundflash1: {
            input: Buffer.alloc(0x100000, 0xff),
            output: 'flash0_blank_region80.u1053',
            transform: bin => { bin[0] = 0x80; return bin; }
        }
    });
}

const NEOGEO_CONFS = {
    bstars2: {
        id: "041",
        rom_size: [ 0x080000, 0x100000, 0x100000 ]
    },
    blazstar: {
        id: "239",
        rom_size: [ 0x200000, 0x400000, 0x400000 ]
    },
    kof97: {
        id: "232",
        rom_size: [ 0x400000, 0x400000, 0x800000 ]
    },
    kof98: {
        id: "242",
        rom_size: [ 0x400000, 0x400000, 0x800000 ],
        name: "kof98h",
        maincpu: { output: ['242-pn1.p1', '242-p2.sp2'] },
        audiocpu: { output: '242-mg1.m1' }
    },
    mslug: {
        id: "201",
        rom_size: [ 0x200000, 0x400000, 0x400000 ],
        swap_68k: true
    },
    mslug2: {
        id: "241",
        rom_size: [ 0x200000, 0x400000, 0x800000 ]
    },
    mslugx: { // wrong checksums
        id: "250",
        rom_size: [ 0x400000, 0x400000, 0x800000 ],
        maincpu: { output: ['250-p1.p1', '250-p2.ep1'] }
    },
    mslug3: {
        id: "256",
        rom_size: [ 0x400000, 0x400000, 0x800000 ],
        sma_encrypt: NeoGeo.mslug3_encrypt_68k,
        cmc_encrypt_gfx: bin =>
            NeoGeo.cmc42_gfx_encrypt(bin, NeoGeo.MSLUG3_GFX_KEY),
        maincpu: { output: ['neo-sma', '256-pg1.p1', '256-pg2.p2'] }
    },
    samsho2: {
        id: "063",
        rom_size: [ 0x200000, 0x200000, 0x200000 ],
        swap_68k: true
    },
    shocktro: {
        id: "238",
        rom_size: [ 0x400000, 0x400000, 0x400000 ]
    },
    twinspri: {
        id: "224",
        rom_size: [ 0x200000, 0x400000, 0x400000 ],
        swap_68k: true
    },
    fatfursp: { // not tested
        id: "058",
        rom_size: [ 0x080000, 0x200000, 0x200000 ]
    },
    lastblad: { // not tested
        id: "234",
        rom_size: [ 0x400000, 0x400000, 0x800000 ]
    },
    shocktr2: { // not tested
        id: "246",
        rom_size: [ 0x400000, 0x400000, 0x800000 ]
    }
};

function neogeo(srcdir, name)
{
    const conf = NEOGEO_CONFS[name];

    const maps_neogeo = {
        zoomy: { input: `${name}_zoom_table`, output: '000-lo.lo' }
    };
    const mainbios = fs.readFileSync(path.join(srcdir, `${name}_bios_m68k`));
    const fixed_bios = fs.readFileSync(path.join(srcdir, `${name}_bios_sfix`));
    let mainbios_name;

    switch (sha1(mainbios)) {
    case '5c6bba07d2ec8ac95776aa3511109f5e1e2e92eb':
        mainbios_name = 'sp-u2.sp1';
        break;
    case '1b3b22092f30c4d1b2c15f04d1670eb1e9fbea07':
        mainbios_name = 'neo-epo.bin';
        break;
    }
    if (mainbios_name)
        maps_neogeo.mainbios = { input: mainbios, output: mainbios_name };

    if (fs.existsSync(path.join(srcdir, `${name}_bios_m68k_jap`))) {
        maps_neogeo.mainbios_jp = {
            input: `${name}_bios_m68k_jap`, output: 'vs-bios.rom'
        };
    }
    if (sha1(fixed_bios) === '3d9c878d6d8e5d47fe58dfbdee31aed5c5b23360') {
        maps_neogeo.fixed_bios = {
            input: fixed_bios, output: 'sfix.sfix',
            transform: NeoGeo.sfix_reorder
        };
    }

    const { id } = conf;
    let maincpu = fs.readFileSync(path.join(srcdir, `${name}_game_m68k`));
    const ymsnd_size = fs.statSync(path.join(srcdir, `${name}_adpcm`)).size;
    const sprites_size = fs.statSync(path.join(srcdir, `${name}_tiles`)).size;
    const maincpu_files = [`${id}-p1.p1`];
    const ymsnd_files = [];
    const sprites_files = [];

    if (maincpu.length > conf.rom_size[0]) {
        if (maincpu.slice(conf.rom_size[0]).every(b => b == 0))
            maincpu = maincpu.slice(0, conf.rom_size[0]);
        else
            maincpu_files.push(`${id}-p2.sp2`);
    }
    for (let i = 1; i <= Math.ceil(ymsnd_size/conf.rom_size[1]); i++)
        ymsnd_files.push(`${id}-v${i}.v${i}`);
    for (let i = 1; i <= Math.ceil(sprites_size/2/conf.rom_size[2])*2; i++)
        sprites_files.push(`${id}-c${i}.c${i}`);

    const maps_game = {
        maincpu: {
            input: maincpu, output: maincpu_files,
            transform: bin => {
                if (conf.swap_68k) {
                    const a = split_at(bin, bin.length/2);
                    bin = Buffer.concat([a[1], a[0]]);
                }
                if ('sma_encrypt' in conf)
                    conf.sma_encrypt(bin);

                const rom_size = conf.rom_size[0];
                if (bin.length == rom_size) return bin;

                const p1_size = bin.length >= 0x100000 + rom_size ?
                      0x100000 : bin.length - rom_size;

                const a = split_at(bin, p1_size);
                if ('sma_encrypt' in conf)
                    a[0] = a[0].slice(0x0c0000);
                return [a[0], ...split(a[1], rom_size)];
            }
        },
        sfix: {
            input: `${name}_game_sfix`, output: `${id}-s1.s1`,
            transform: NeoGeo.sfix_reorder
        },
        audiocpu: { input: `${name}_game_z80`, output: `${id}-m1.m1` },
        ymsnd: {
            input: `${name}_adpcm`, output: ymsnd_files,
            transform: bin => split(bin, conf.rom_size[1])
        },
        sprites: {
            input: `${name}_tiles`, output: sprites_files,
            transform: bin => {
                NeoGeo.deoptimize_sprites(bin);
                if ('cmc_encrypt_gfx' in conf)
                    conf.cmc_encrypt_gfx(bin);
                const a = interleave(bin).map(b => split(b, conf.rom_size[2]));
                return a[0].flatMap((b, i) => [b, a[1][i]]);
            }
        }
    };

    for (const region of ['maincpu', 'audiocpu'])
        if (region in conf)
            Object.assign(maps_game[region], conf[region]);
    if ('cmc_encrypt_gfx' in conf)
        delete maps_game.sfix;

    convert_roms('neogeo', srcdir, maps_neogeo);
    convert_roms(conf.name || name, srcdir, maps_game);
}

function find_neogeo_roms(dir)
{
    for (const f of fs.readdirSync(dir))
        if (f.endsWith('_game_m68k'))
            return f.replace('_game_m68k', '');
    return null;
}

const srcdir = process.argv[2] || '';
if (fs.existsSync(path.join(srcdir, 'ddragon_hd6309.bin'))) {
    ddragon(srcdir);
    ddragon2(srcdir);
    ddragon3(srcdir);
}
else if (fs.existsSync(path.join(srcdir, 'RTYPE_CPU.BIN')))
    rtype(srcdir);
else if (fs.existsSync(path.join(srcdir, 'RTYPE2_CPU1.BIN')))
    rtype2(srcdir);
else if (fs.existsSync(path.join(srcdir, 'AIRDUEL_CPU.BIN'))) {
    airduelm72(srcdir);
    bchopper(srcdir);
    bmaster(srcdir);
    cosmccop(srcdir);
    dbreedm72(srcdir);
    gunforce(srcdir);
    gunforc2(srcdir);
    hharry(srcdir);
    imgfight(srcdir);
    inthunt(srcdir);
    kungfum(srcdir);
    loht(srcdir);
    mysticri(srcdir);
    nspirit(srcdir);
    rtypeleo(srcdir);
    ssoldier(srcdir);
    uccops(srcdir);
    vigilantbl(srcdir);
}
else if (fs.existsSync(path.join(srcdir, 'raiden_maincpu.bin')))
    raidenb(srcdir);
else if (fs.existsSync(path.join(srcdir, 'rdft_i386.bin')))
    rdftj(srcdir);
else if (fs.existsSync(path.join(srcdir, 'rdft2_i386.bin')))
    rdft2(srcdir);
else if (fs.existsSync(path.join(srcdir, 'rfjet_i386.bin')))
    rfjet(srcdir);
else if (find_neogeo_roms(srcdir))
    neogeo(srcdir, find_neogeo_roms(srcdir));
else
    console.log('Usage: node dotemu2mame.js [ROM directory]');


function fix_mame_zip_name(name)
{
    // SGM FIX:
    // If shocktro, use shocktroa as name, because that's the version of the ROM in this NeoGeo Rom
    if (name === 'shocktro')
        name = 'shocktroa'    

    return name
}
