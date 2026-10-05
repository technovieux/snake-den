#!/usr/bin/env bash

# Nom du fichier de sortie fixe
OUTPUT_FILE="OS_LIST.json"

quickget --list-json | jq '
  group_by(.OS) | map(
    (.[0]["Display Name"] | ascii_downcase) as $name |
    (
      if $name | contains("server") then "server"
      elif $name | contains("bsd") then "bsd"
      elif $name | contains("macos") then "macos"
      elif $name | contains("windows") then "windows"
      else "linux"
      end
    ) as $cat |
    {
      id: .[0].OS,
      name: .[0]["Display Name"],
      category: $cat,
      releases: (
        group_by(.Release) | map({
          release: .[0].Release,
          options: (map(.Option) | map(select(. != "")) | unique)
        })
      ),
      icon: "/OS_ICONS/\(.[0].OS).png",
      iconUrl: .[0].PNG
    }
  )
' > "$OUTPUT_FILE"

echo "Fichier généré avec succès : $OUTPUT_FILE"