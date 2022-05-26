#!/bin/bash

for orig_file in ./*/*.nes;
do
  echo Working on $orig_file...
  file_dir=$(dirname $orig_file)
  cd $file_dir
  orig_file_name=$(basename $orig_file)
  cart_name=${orig_file_name::-4}
  game_name_line=$(grep Name $cart_name.desktop | tr -d ' '':'\')
  source <(echo $game_name_line)
  game_name=$Name
  target_filename="$game_name"-"$cart_name".nes
  echo Game is $game_name

  cp $orig_file_name ../$target_filename
  echo Copied to ../$target_filename
  
  cd ..
done
