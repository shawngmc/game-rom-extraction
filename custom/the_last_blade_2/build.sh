#!/bin/bash

# TODO: Figure this out!!

IN_DIR=$1
OUT_DIR=$2

GAME_ID=243

# python3 ../../cli_tools/toolbox.py file slice --in "$IN_DIR/v1.bin" --start 0 --length 4194304 --out "$OUT_DIR/$GAME_ID-v1.v1" 
# python3 ../../cli_tools/toolbox.py file slice --in "$IN_DIR/v1.bin" --start 4194304 --length 4194304 --out "$OUT_DIR/$GAME_ID-v2.v2" 
# python3 ../../cli_tools/toolbox.py file slice --in "$IN_DIR/v1.bin" --start 8388608 --length 4194304 --out "$OUT_DIR/$GAME_ID-v3.v3" 
# python3 ../../cli_tools/toolbox.py file slice --in "$IN_DIR/v1.bin" --start 12582912 --length 4194304 --out "$OUT_DIR/$GAME_ID-v4.v4"


python3 ../../cli_tools/toolbox.py file deinterleave --in "$IN_DIR/c1.bin" --out1 "$OUT_DIR/$GAME_ID-c1.odd" --out2 "$OUT_DIR/$GAME_ID-c1.even" 
python3 ../../cli_tools/toolbox.py file slice --in "$OUT_DIR/$GAME_ID-c1.odd" --start 0 --length 8388608 --out "$OUT_DIR/$GAME_ID-c1.c1" 
python3 ../../cli_tools/toolbox.py file slice --in "$OUT_DIR/$GAME_ID-c1.odd" --start 8388608 --length 8388608 --out "$OUT_DIR/$GAME_ID-c3.c3" 
python3 ../../cli_tools/toolbox.py file slice --in "$OUT_DIR/$GAME_ID-c1.odd" --start 16777216 --length 8388608 --out "$OUT_DIR/$GAME_ID-c5.c5" 
python3 ../../cli_tools/toolbox.py file slice --in "$OUT_DIR/$GAME_ID-c1.even" --start 0 --length 8388608 --out "$OUT_DIR/$GAME_ID-c2.c2" 
python3 ../../cli_tools/toolbox.py file slice --in "$OUT_DIR/$GAME_ID-c1.even" --start 8388608 --length 8388608 --out "$OUT_DIR/$GAME_ID-c4.c4" 
python3 ../../cli_tools/toolbox.py file slice --in "$OUT_DIR/$GAME_ID-c1.even" --start 16777216 --length 8388608 --out "$OUT_DIR/$GAME_ID-c6.c6" 


# python3 ../../cli_tools/toolbox.py file slice --in "$IN_DIR/c1.bin" --start 0 --length 8388608 --out "$OUT_DIR/$GAME_ID-c1" 
# python3 ../../cli_tools/toolbox.py file slice --in "$IN_DIR/c1.bin" --start 8388608 --length 8388608 --out "$OUT_DIR/$GAME_ID-c2" 
# python3 ../../cli_tools/toolbox.py file slice --in "$IN_DIR/c1.bin" --start 16777216 --length 8388608 --out "$OUT_DIR/$GAME_ID-c3" 
# python3 ../../cli_tools/toolbox.py file slice --in "$IN_DIR/c1.bin" --start 25165824 --length 8388608 --out "$OUT_DIR/$GAME_ID-c4" 
# python3 ../../cli_tools/toolbox.py file slice --in "$IN_DIR/c1.bin" --start 33554432 --length 8388608 --out "$OUT_DIR/$GAME_ID-c5" 
# python3 ../../cli_tools/toolbox.py file slice --in "$IN_DIR/c1.bin" --start 41943040 --length 8388608 --out "$OUT_DIR/$GAME_ID-c6" 