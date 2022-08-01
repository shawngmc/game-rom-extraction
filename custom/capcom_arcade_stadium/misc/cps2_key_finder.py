
import hashlib
# import json
import zlib
import math

# def read_key_descs():
#     with open('keydesc.json') as f:
#         return json.load(f)


# key_desc_list = read_key_descs()

# for raw_goal_crc, key_desc in key_desc_list.items():

raw_goal_crc = "7a09403c"
key_desc = dict()
key_desc['sha'] = "1a37f09028714d2b0f4543fab3cbfe5ba4b571ff"
goal_crc_val = int(raw_goal_crc, 16)
goal_sha_val = int(key_desc['sha'], 16)
length = 20
max_val = int(math.pow(2, 8 * length))
dot_check = int(math.pow(2, 30))
i = 0
while True:
    check_bytes = i.to_bytes(16, 'little')
    crc = zlib.crc32(check_bytes) & 0xffffffff
    if crc == goal_crc_val:
        print(f'POSSIBLE: crc on {i}')
        m = hashlib.sha1()
        m.update(check_bytes)
        if m.digest() == goal_sha_val:
            print(f'FOUND MATCH: crc and sha on {i}')
            exit()
        else:
            print("SHA1 mismatch")
    i += 1

    # print a dot every 2^30 (1073741824), which is still a tiny fraction of the key_space
    # if i & 5 == 0:
    #     # print(".", end ="", flush=True)
    #     print(i)
    #     if i >= max_val:
    #         print("NO MATCH")
    #         exit()

