#!/bin/python3

import glob
import json
import zipfile


mame_subfolder_ids = [1556690, 1556700, 1556701, 1556702, 1556703, 1556704, 1556705, 1556706, 1556707, 1556708, 1556709, 1556710, 1556711, 1556713, 1556717, 1556718, 1556719, 1556720, 1556721, 1556723]

mame_merged_ids = [1556722, 1556724, 1556725, 1556726, 1556727, 1556728, 1556729]

mame_basefolder_ids = [1556712, 1556714, 1556715, 1556716]

def read_romlist():
    with open('romlist.json') as f:
        return json.load(f)


def get_id_from_name(filename):
    return filename[16:-4]


def find_files():
    return glob.glob('./in/*.pak')


def handle_subfolder_rom(rompath, metadata):
    # create new zipfile
    with zipfile.ZipFile(f"./out/{metadata['mamename']}.zip", "x") as new_archive:
        # open old zipfile
        with zipfile.ZipFile(rompath, "r") as old_archive:
            # for each file in zipfile
            for file_entry in old_archive.infolist(): 
                # read zip file entry
                print(file_entry)
                with old_archive.open(file_entry) as file_read_obj:
                    file_data = file_read_obj.read()
                    
                    # change the name
                    old_name = file_entry.filename
                    new_name = old_name[len(metadata['mamename'])+1:len(old_name)]
                    print(new_name)

                    # add to new archive
                    new_archive.writestr(new_name, file_data)


def handle_basefolder_rom(rompath, metadata):
    # create new zipfile
    with zipfile.ZipFile(f"./out/{metadata['mamename']}.zip", "x") as new_archive:
        # open old zipfile
        with zipfile.ZipFile(rompath, "r") as old_archive:
            # for each file in zipfile
            for file_entry in old_archive.infolist(): 
                # read zip file entry
                print(file_entry)
                with old_archive.open(file_entry) as file_read_obj:
                    file_data = file_read_obj.read()

                    # add to new archive
                    new_archive.writestr(file_entry.filename, file_data)


def handle_merged_rom(rompath, metadata):
    print("NYI")


def main():
    romlist = read_romlist()["roms"]
    files = find_files()
    for file in files:
        id = get_id_from_name(file)
        print(f"{file}: {id}")
        if id in romlist:
            rom_metadata = romlist[id]
            print(rom_metadata)
            if rom_metadata["method"] == "subfolder":
                handle_subfolder_rom(file, rom_metadata)
            elif rom_metadata["method"] == "basefolder":
                handle_basefolder_rom(file, rom_metadata)
            elif rom_metadata["method"] == "merged":
                handle_merged_rom(file, rom_metadata)
            else:
                print("Unknown handling; skipping...")
        else:
            print("Not in romlist; skipping...")


main()


