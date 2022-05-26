#!/bin/bash

for orig_file in ./*/*.sfrom;
do
  echo Working on $orig_file...
  file_dir=$(dirname $orig_file)
  cd $file_dir
  orig_file_name=$(basename $orig_file)
  cart_name=${orig_file_name::-6}
  game_name_line=$(grep Name $cart_name.desktop | tr -d ' '':'\')
  source <(echo $game_name_line)
  game_name=$Name
  target_filename="$game_name"-"$cart_name".smc
  echo Game is $game_name

  ../sfrom2sfc.exe $orig_file_name

  rom_file=*.rom
  pcm_file=*.pcm
  has_pcm=`ls -1 *.pcm | wc -l`
  if [ $has_pcm -gt 0 ]
  then  
    echo "Found PCM data for $cart_name, restoring..."
    ../plombo-vcromclaim/vcromclaim-master/snesrestore.py $rom_file $pcm_file ../$target_filename
    echo "PCM data restored in new rom in main folder..."
  else
    echo "No PCM data found - copying rom over..."
    cp $rom_file ../$target_filename
  fi
  
  cd ..
done
