import glob
import json
import zipfile
import sys
import zlib
import base64
import logging, sys
import os
import io

logging.basicConfig(stream=sys.stderr, level=logging.INFO)

def read_romlist():
    with open('romlist.json') as f:
        return json.load(f)

def get_id_from_name(filename):
    return filename[-11:-4]

def find_files(in_path):
    return glob.glob(in_path +'/*.pak')

def parse_kpka_archive(bytes):
    
    magic_string = bytes[0:4].decode("utf-8")
    if magic_string != "KPKA":
        raise Exception("Not a valid KPKA archive!")
    else:
        files = {}
        logging.debug("KPKA detected!")
        logging.debug(f'Archive Size: {len(bytes)}')
        version = int.from_bytes(bytes[4:8], sys.byteorder)
        logging.debug(f'Version: {version}')
        total_files = int.from_bytes(bytes[8:12], sys.byteorder)
        logging.debug(f'Number of files: {total_files}')
        dummy_val = int.from_bytes(bytes[12:16], sys.byteorder)

        curr_pos = 16
        for x in range(0, total_files):
            logging.debug(f'  file: {x}')
            name_crc_l = int.from_bytes(bytes[curr_pos:curr_pos+4], sys.byteorder)
            logging.debug(f'    name_crc_l: {name_crc_l}')
            name_crc_u = int.from_bytes(bytes[curr_pos+4:curr_pos+8], sys.byteorder)
            logging.debug(f'    name_crc_u: {name_crc_u}')
            offset = int.from_bytes(bytes[curr_pos+8:curr_pos+16], sys.byteorder)
            logging.debug(f'    offset: {offset}')
            zsize = int.from_bytes(bytes[curr_pos+16:curr_pos+24], sys.byteorder)
            logging.debug(f'    zsize: {zsize}')
            size = int.from_bytes(bytes[curr_pos+24:curr_pos+32], sys.byteorder)
            logging.debug(f'    size: {size}')
            flag = int.from_bytes(bytes[curr_pos+32:curr_pos+40], sys.byteorder)
            logging.debug(f'    flag: {flag}')
            dummy_2 = int.from_bytes(bytes[curr_pos+40:curr_pos+44], sys.byteorder)
            logging.debug(f'    dummy_2: {dummy_2}')
            dummy_3 = int.from_bytes(bytes[curr_pos+44:curr_pos+48], sys.byteorder)
            logging.debug(f'    dummy_3: {dummy_3}')

            # Handle the flag
            if flag == 0 or flag == 1024:
                contents = bytes[offset:offset+size]
            elif flag == 1:
                contents = bytes[offset:offset+zsize]
                contents = zlib.decompress(contents, wbits = -15)
                logging.debug(f'    decompressed size: {len(contents)} bytes')
            elif flag == 2:
                logging.warning("zstd NYI!")
                contents = bytes[offset:offset+zsize]
            else:
                logging.warning(f'Compression flag {flag} NYI!')
                logging.warning(f'    zsize: {zsize}')
                logging.warning(f'    size: {size}')
                contents = bytes[offset:offset+zsize]

            files[offset] = contents
            curr_pos = curr_pos + 48

        return files

def split_1941(contents):
    # open old zipfile
    with zipfile.ZipFile(io.BytesIO(contents), "r") as old_archive:
        zip_entries = list(old_archive.infolist())

        def getName(zip_entry):
            return zip_entry.filename.split('/')[1]

        out_files = dict()
        new_contents = io.BytesIO()
        with zipfile.ZipFile(new_contents, "w") as new_archive:
            for file_entry in zip_entries:
                # read in the entry - we need the body either way
                with old_archive.open(file_entry) as file_read_obj:
                    file_data = file_read_obj.read()
                    try:
                        # if there is a slash, it's a 1941j file
                        index = zip_entries[0].filename.index('/')
                        new_archive.writestr(getName(file_entry), file_data)

                    except:
                        # It's the 1941.zip
                        out_files['1941.zip'] = file_data
 
        
        out_files[f'1941j.zip'] = new_contents.getvalue()
        return out_files


def rebuild_mame_subfolder_zip(contents):
    # open old zipfile
    with zipfile.ZipFile(io.BytesIO(contents), "r") as old_archive:
        zip_entries = list(old_archive.infolist())
        
        def getPrefix(zip_entry):
            return zip_entry.filename.split('/')[0]

        def getName(zip_entry):
            return zip_entry.filename.split('/')[1]

        # first, check the zip entries
        try:
            index = zip_entries[0].filename.index('/')
        except Exception as e:
            print(e)
            print(zip_entries[0])
            raise Exception(f'not a mame subfolder zip - no slash in first zip entry')

        prefix = getPrefix(zip_entries[0])
        for file_entry in zip_entries:
            if getPrefix(file_entry) != prefix:
                raise Exception(f'not a mame subfolder zip - {getPrefix(file_entry)} != {prefix}')

        new_contents = io.BytesIO()
        with zipfile.ZipFile(new_contents, "w") as new_archive:
            for file_entry in zip_entries:
                with old_archive.open(file_entry) as file_read_obj:
                    file_data = file_read_obj.read()
 
                    # add to new archive
                    new_archive.writestr(getName(file_entry), file_data)
        
        ret_obj = dict()
        ret_obj['filename'] = f'{prefix}.zip'
        ret_obj['contents'] = new_contents.getvalue()
        return ret_obj

def main():
    args = sys.argv[1:]
    in_path = args[0]
    out_path = args[1]
    romlist = read_romlist()["roms"]
    files = find_files(in_path)
    for file in files:
        id = get_id_from_name(file)
        logging.debug(f"{file}: {id}")
        if id in romlist: 
            rom_metadata = romlist[id]  
            print(rom_metadata)
            try:
                with open(file, "rb") as curr_file:
                    file_content = bytearray(curr_file.read())
                    kpka_contents = parse_kpka_archive(file_content)

                    # Remove non-zip files
                    kpka_zips = dict()
                    for offset, contents in kpka_contents.items():
                        if (contents[0:2].decode("utf-8") == "PK"):
                            kpka_zips[offset] = contents

                    def find_override(rom_metadata, offset):
                        if not "overrides" in rom_metadata:
                            return None
                        
                        overrides = rom_metadata['overrides']
                        matches = [item for item in overrides if item['kpka_offset'] == offset]
                        if (len(matches) == 0):
                            return None
                        elif (len(matches) == 1):
                            return matches[0]
                        else:
                            raise Exception("Too many override matches!")
                        

                    for offset, contents in kpka_zips.items():
                        override = find_override(rom_metadata, offset)
                        if override:
                            if not 'strategy' in override:
                                print(f'********* Override for file offset {offset} has no strategy!')
                                filename = f'BAD_{id}_{offset}_nyi.zip'
                                with open(os.path.join(out_path, filename), "wb") as out_file:
                                    out_file.write(contents)
                            elif override['strategy'] == "rename":
                                filename = f'{override["mame_name"]}.zip'
                                with open(os.path.join(out_path, filename), "wb") as out_file:
                                    out_file.write(contents)
                            elif override['strategy'] == "split_1941":
                                # This is a weird one - 1941.zip is in the zip, and 1941j/* is 1944j.zip
                                new_files = split_1941(contents)
                                for filename, contents in new_files.items():
                                    with open(os.path.join(out_path, filename), "wb") as out_file:
                                        out_file.write(contents)
                            elif override['strategy'] == "demerge":
                                print(f'********* Override for file offset {offset} demerge NYI!')
                                filename = f'BAD_{id}_{offset}_{override["mame_name"]}_demerge_nyi.zip'
                                with open(os.path.join(out_path, filename), "wb") as out_file:
                                    out_file.write(contents)
                            else:
                                print(f'********* Override for file offset {offset} {override["strategy"]} NYI!')
                                filename = f'BAD_{id}_{offset}_{override["strategy"]}_nyi.zip'
                                with open(os.path.join(out_path, filename), "wb") as out_file:
                                    out_file.write(contents)
                        else:
                            try:
                                rebuilt = rebuild_mame_subfolder_zip(contents)
                                with open(os.path.join(out_path, rebuilt['filename']), "wb") as out_file:
                                    out_file.write(rebuilt['contents'])
                            except Exception as e:
                                print(e)
            except Exception as e:
                print(e)
                print('Error While Opening the file!') 
            # # if rom_metadata["method"] == "subfolder":
            # #     handle_subfolder_rom(file, rom_metadata)
            # # elif rom_metadata["method"] == "basefolder":
            # #     handle_basefolder_rom(file, rom_metadata)
            # # elif rom_metadata["method"] == "merged":
            # #     handle_merged_rom(file, rom_metadata)
            # if rom_metadata["method"] == "subzip":
            #     handle_subzip_rom(file, rom_metadata)
            # else:
            #     print("Unknown handling; skipping...")
        else:
            logging.info(f'{file} not in romlist; skipping...')


main()


