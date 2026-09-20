#!/bin/zsh
# Synthetic narrator only. No microphone. Original commands are preserved.
set -e
cd "${0:A:h}"
mkdir -p assets/speech
wardrobePhrases=('Put a denim jacket on me.' 'Add black square sunglasses, and keep the jacket.' 'Make them pink.' 'Make them bigger.')
wardrobeNames=('01-jacket' '02-sunglasses' '03-pink' '04-bigger')
for i in 1 2 3 4; do
  say -v Samantha -r 145 -o "/tmp/wardrobe-${wardrobeNames[$i]}.aiff" "${wardrobePhrases[$i]}"
  afconvert -f WAVE -d LEI16@16000 "/tmp/wardrobe-${wardrobeNames[$i]}.aiff" "assets/speech/${wardrobeNames[$i]}.wav"
done
