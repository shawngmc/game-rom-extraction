import traceback
import hashlib
import glob
import json
import zipfile
import sys
import zlib
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

def transforms(contents, override_meta):
    # Load the zip file contents
    orig_data = dict()
    with zipfile.ZipFile(io.BytesIO(contents), "r") as old_archive:
        zip_entries = list(old_archive.infolist())

        def getType(zip_entry):
            return zip_entry.filename.split('.')[1]

        for file_entry in zip_entries:
            # read in the entry - we need the body either way
            with old_archive.open(file_entry) as file_read_obj:
                file_data = file_read_obj.read()
                type_name = getType(file_entry)
                orig_data[type_name] = file_data

    # Process each section
    new_data = dict()
    for part_type, part_metadata in override_meta['parts'].items():
        print(f'  Processing {part_type}...')
        part_file_entries = part_metadata['files']
        file_names = list(map(lambda chunk: chunk['name'], part_file_entries))
        chunks = [orig_data[part_type]]
        for transform in part_metadata['transforms']:
            new_chunks = []
            if transform['action'] == "split":
                for chunk in chunks:
                    num_chunks = transform['ways']
                    start_offset = 0
                    chunk_size = len(chunk)//num_chunks
                    for i in range(0, num_chunks):
                        new_chunks.append(bytearray(chunk[start_offset:start_offset+chunk_size]))
                        start_offset = start_offset + chunk_size
            elif transform['action'] == "split_size":
                for chunk in chunks:
                    sizes = transform['sizes']
                    num_chunks = len(sizes)
                    start_offset = 0
                    for i in range(0, num_chunks):
                        new_chunks.append(bytearray(chunk[start_offset:start_offset+sizes[i]]))
                        start_offset = start_offset + sizes[i]
            elif transform['action'] == "deinterleave":
                for chunk in chunks:
                    num_ways = transform['ways']
                    chunk_size = len(chunk)//num_ways
                    word_size = transform['word_size_bytes']
                    interleave_group_length = num_ways * word_size
                    num_interleave_groups = len(chunk)//interleave_group_length
                    temp_chunks = [bytearray() for i in range(num_ways)]
                    for i in range(0, num_interleave_groups):
                        offset = i * interleave_group_length
                        interleave_group = chunk[offset:offset+interleave_group_length]
                        interleave_offset = 0
                        for j in range(0, num_ways):
                            interleave_end = interleave_offset + word_size
                            temp_chunks[j].extend(interleave_group[interleave_offset:interleave_end])
                            interleave_offset = interleave_end
                    new_chunks += temp_chunks
            elif transform['action'] == "truncate":
                max_size = transform['max_length_bytes']
                for chunk in chunks:
                    if len(chunk) > max_size:
                        new_chunks.append(chunk[0:max_size])
                    else:
                        new_chunks.append(chunk)
            elif transform['action'] == "splice_out":
                start = transform['start']
                end = transform['end']
                for chunk in chunks:
                    new_chunk = bytearray()
                    new_chunk.extend(chunk[0:start])
                    new_chunk.extend(chunk[end:len(chunk)])
                    new_chunks.append(new_chunk)
            elif transform['action'] == "endian":
                for chunk in chunks:  
                    # print(f'    chunk size: {len(chunk)}')
                    new_chunk = bytearray(len(chunk))
                    new_chunk[0::2] = chunk[1::2]
                    new_chunk[1::2] = chunk[0::2]
                    new_chunks.append(new_chunk)
            else:
                raise Exception(f'********* Transform action {transform["action"]} NYI!')

            chunks = new_chunks

        for i in range(0, len(chunks)):
            chunk = chunks[i]
            name = file_names[i]
            exp_hash = part_file_entries[i]["sha1"]
            m = hashlib.sha1()
            m.update(chunk)
            if m.hexdigest() == exp_hash:
                new_data[name] = chunk
            else:
                print(f'Bad Checksum for {name}: got {m.hexdigest()} with length {len(chunk)}, expected {exp_hash}')
                new_data[name] = chunk

    # Build the new zip file
    new_contents = io.BytesIO()
    with zipfile.ZipFile(new_contents, "w") as new_archive:
        for name, data in new_data.items():
            new_archive.writestr(name, data)

    return new_contents.getvalue()

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
            # print(rom_metadata)
            print(f'Extracting {rom_metadata["name"]}...')
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
                            print(f' Processing override for {override["mame_name"]}...')
                            if not 'strategy' in override:
                                # print(f'********* Override for file offset {offset} has no strategy!')
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
                                # print(f'********* Override for file offset {offset} demerge NYI!')
                                filename = f'BAD_{id}_{offset}_{override["mame_name"]}_demerge_nyi.zip'
                                with open(os.path.join(out_path, filename), "wb") as out_file:
                                    out_file.write(contents)
                            elif override['strategy'] == "transforms":
                                new_contents = transforms(contents, override)
                                with open(os.path.join(out_path, f'{override["mame_name"]}.zip'), "wb") as out_file:
                                    out_file.write(new_contents)
                                with open(os.path.join(out_path, f'{override["mame_name"]}_orig.zip'), "wb") as out_file:
                                    out_file.write(contents)
                            else:
                                # print(f'********* Override for file offset {offset} {override["strategy"]} NYI!')
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
                print(repr(e))
                traceback.print_exc()
                print('Error While Opening the file!') 
        else:
            logging.info(f'{file} not in romlist; skipping...')

    print("""
        Processing complete. 

        TODOs:
         - Implement more games with this framework
         - Add CLI flags
         - Figure out fixes for the 'incomplete' games
           - Source for dl-1425.bin
           - How do we find/reproduce the enc keys

    """)

main()


