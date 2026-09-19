// รูปแบบ: id ต้องไม่ซ้ำกัน, apiName คือชื่อที่ใช้ค้นจาก PokeAPI (pokeapi.co)
// วิธีหาชื่อ Mega: ปกติจะเป็น "ชื่อ-mega" เช่น "gengar-mega"
// บางตัวมี X/Y เช่น "charizard-mega-x", "charizard-mega-y"
// เช็คชื่อที่ถูกต้องได้ที่ https://pokeapi.co/api/v2/pokemon/ชื่อ
export const POKEMON_LIST = [
  {
    "id": 1,
    "apiName": "grass",
    "displayName": "Grass",
    "isMega": false
  },
  {
    "id": 2,
    "apiName": "fire",
    "displayName": "Fire",
    "isMega": false
  },
  {
    "id": 3,
    "apiName": "water",
    "displayName": "Water",
    "isMega": false
  },
  {
    "id": 4,
    "apiName": "bug",
    "displayName": "Bug",
    "isMega": false
  },
  {
    "id": 5,
    "apiName": "normal",
    "displayName": "Normal",
    "isMega": false
  },
  {
    "id": 6,
    "apiName": "poison",
    "displayName": "Poison",
    "isMega": false
  },
  {
    "id": 7,
    "apiName": "electric",
    "displayName": "Electric",
    "isMega": false
  },
  {
    "id": 8,
    "apiName": "electric",
    "displayName": "Electric",
    "isMega": false
  },
  {
    "id": 9,
    "apiName": "electric",
    "displayName": "Electric",
    "isMega": false
  },
  {
    "id": 10,
    "apiName": "fairy",
    "displayName": "Fairy",
    "isMega": false
  },
  {
    "id": 11,
    "apiName": "fire",
    "displayName": "Fire",
    "isMega": false
  },
  {
    "id": 12,
    "apiName": "ice",
    "displayName": "Ice",
    "isMega": false
  },
  {
    "id": 13,
    "apiName": "fire",
    "displayName": "Fire",
    "isMega": false
  },
  {
    "id": 14,
    "apiName": "fire",
    "displayName": "Fire",
    "isMega": false
  },
  {
    "id": 15,
    "apiName": "psychic",
    "displayName": "Psychic",
    "isMega": false
  },
  {
    "id": 16,
    "apiName": "fighting",
    "displayName": "Fighting",
    "isMega": false
  },
  {
    "id": 17,
    "apiName": "grass",
    "displayName": "Grass",
    "isMega": false
  },
  {
    "id": 18,
    "apiName": "water",
    "displayName": "Water",
    "isMega": false
  },
  {
    "id": 19,
    "apiName": "poison",
    "displayName": "Poison",
    "isMega": false
  },
  {
    "id": 20,
    "apiName": "ghost",
    "displayName": "Ghost",
    "isMega": false
  },
  {
    "id": 21,
    "apiName": "normal",
    "displayName": "Normal",
    "isMega": false
  },
  {
    "id": 22,
    "apiName": "water",
    "displayName": "Water",
    "isMega": false
  },
  {
    "id": 23,
    "apiName": "bug",
    "displayName": "Bug",
    "isMega": false
  },
  {
    "id": 24,
    "apiName": "normal",
    "displayName": "Normal",
    "isMega": false
  },
  {
    "id": 25,
    "apiName": "fighting",
    "displayName": "Fighting",
    "isMega": false
  },
  {
    "id": 26,
    "apiName": "fighting",
    "displayName": "Fighting",
    "isMega": false
  },
  {
    "id": 27,
    "apiName": "fighting",
    "displayName": "Fighting",
    "isMega": false
  },
  {
    "id": 28,
    "apiName": "water",
    "displayName": "Water",
    "isMega": false
  },
  {
    "id": 29,
    "apiName": "normal",
    "displayName": "Normal",
    "isMega": false
  },
  {
    "id": 30,
    "apiName": "water",
    "displayName": "Water",
    "isMega": false
  },
  {
    "id": 31,
    "apiName": "electric",
    "displayName": "Electric",
    "isMega": false
  },
  {
    "id": 32,
    "apiName": "fire",
    "displayName": "Fire",
    "isMega": false
  },
  {
    "id": 33,
    "apiName": "rock",
    "displayName": "Rock",
    "isMega": false
  },
  {
    "id": 34,
    "apiName": "normal",
    "displayName": "Normal",
    "isMega": false
  },
  {
    "id": 35,
    "apiName": "dragon",
    "displayName": "Dragon",
    "isMega": false
  },
  {
    "id": 36,
    "apiName": "grass",
    "displayName": "Grass",
    "isMega": false
  },
  {
    "id": 37,
    "apiName": "fire",
    "displayName": "Fire",
    "isMega": false
  },
  {
    "id": 38,
    "apiName": "fire",
    "displayName": "Fire",
    "isMega": false
  },
  {
    "id": 39,
    "apiName": "water",
    "displayName": "Water",
    "isMega": false
  },
  {
    "id": 40,
    "apiName": "bug",
    "displayName": "Bug",
    "isMega": false
  },
  {
    "id": 41,
    "apiName": "electric",
    "displayName": "Electric",
    "isMega": false
  },
  {
    "id": 42,
    "apiName": "water",
    "displayName": "Water",
    "isMega": false
  },
  {
    "id": 43,
    "apiName": "water",
    "displayName": "Water",
    "isMega": false
  },
  {
    "id": 44,
    "apiName": "psychic",
    "displayName": "Psychic",
    "isMega": false
  },
  {
    "id": 45,
    "apiName": "dark",
    "displayName": "Dark",
    "isMega": false
  },
  {
    "id": 46,
    "apiName": "water",
    "displayName": "Water",
    "isMega": false
  },
  {
    "id": 47,
    "apiName": "poison",
    "displayName": "Poison",
    "isMega": false
  },
  {
    "id": 48,
    "apiName": "bug",
    "displayName": "Bug",
    "isMega": false
  },
  {
    "id": 49,
    "apiName": "steel",
    "displayName": "Steel",
    "isMega": false
  },
  {
    "id": 50,
    "apiName": "bug",
    "displayName": "Bug",
    "isMega": false
  },
  {
    "id": 51,
    "apiName": "bug",
    "displayName": "Bug",
    "isMega": false
  },
  {
    "id": 52,
    "apiName": "steel",
    "displayName": "Steel",
    "isMega": false
  },
  {
    "id": 53,
    "apiName": 
 []
 [
  {
    "id": 1,
    "apiName": "venusaur",
    "displayName": "Venusaur",
    "isMega": false
  },
  {
    "id": 4,
    "apiName": "learnset",
    "displayName": "Learnset",
    "isMega": false
  },
  {
    "id": 6,
    "apiName": "charizard",
    "displayName": "Charizard",
    "isMega": false
  },
  {
    "id": 11,
    "apiName": "blastoise",
    "displayName": "Blastoise",
    "isMega": false
  },
  {
    "id": 15,
    "apiName": "beedrill",
    "displayName": "Beedrill",
    "isMega": false
  },
  {
    "id": 20,
    "apiName": "pidgeot",
    "displayName": "Pidgeot",
    "isMega": false
  },
  {
    "id": 25,
    "apiName": "arbok",
    "displayName": "Arbok",
    "isMega": false
  },
  {
    "id": 29,
    "apiName": "pikachu",
    "displayName": "Pikachu",
    "isMega": false
  },
  {
    "id": 33,
    "apiName": "raichu",
    "displayName": "Raichu",
    "isMega": false
  },
  {
    "id": 42,
    "apiName": "clefable",
    "displayName": "Clefable",
    "isMega": false
  },
  {
    "id": 46,
    "apiName": "ninetales",
    "displayName": "Ninetales",
    "isMega": false
  },
  {
    "id": 55,
    "apiName": "arcanine",
    "displayName": "Arcanine",
    "isMega": false
  },
  {
    "id": 64,
    "apiName": "alakazam",
    "displayName": "Alakazam",
    "isMega": false
  },
  {
    "id": 68,
    "apiName": "machamp",
    "displayName": "Machamp",
    "isMega": false
  },
  {
    "id": 69,
    "apiName": "fighting",
    "displayName": "Fighting",
    "isMega": false
  },
  {
    "id": 72,
    "apiName": "victreebel",
    "displayName": "Victreebel",
    "isMega": false
  },
  {
    "id": 77,
    "apiName": "slowbro",
    "displayName": "Slowbro",
    "isMega": false
  },
  {
    "id": 87,
    "apiName": "gengar",
    "displayName": "Gengar",
    "isMega": false
  },
  {
    "id": 92,
    "apiName": "kangaskhan",
    "displayName": "Kangaskhan",
    "isMega": false
  },
  {
    "id": 96,
    "apiName": "starmie",
    "displayName": "Starmie",
    "isMega": false
  },
  {
    "id": 101,
    "apiName": "pinsir",
    "displayName": "Pinsir",
    "isMega": false
  },
  {
    "id": 105,
    "apiName": "tauros",
    "displayName": "Tauros",
    "isMega": false
  },
  {
    "id": 123,
    "apiName": "gyarados",
    "displayName": "Gyarados",
    "isMega": false
  },
  {
    "id": 128,
    "apiName": "ditto",
    "displayName": "Ditto",
    "isMega": false
  },
  {
    "id": 132,
    "apiName": "vaporeon",
    "displayName": "Vaporeon",
    "isMega": false
  },
  {
    "id": 136,
    "apiName": "jolteon",
    "displayName": "Jolteon",
    "isMega": false
  },
  {
    "id": 140,
    "apiName": "flareon",
    "displayName": "Flareon",
    "isMega": false
  },
  {
    "id": 144,
    "apiName": "aerodactyl",
    "displayName": "Aerodactyl",
    "isMega": false
  },
  {
    "id": 149,
    "apiName": "snorlax",
    "displayName": "Snorlax",
    "isMega": false
  },
  {
    "id": 153,
    "apiName": "dragonite",
    "displayName": "Dragonite",
    "isMega": false
  },
  {
    "id": 158,
    "apiName": "meganium",
    "displayName": "Meganium",
    "isMega": true
  },
  {
    "id": 162,
    "apiName": "typhlosion",
    "displayName": "Typhlosion",
    "isMega": false
  },
  {
    "id": 171,
    "apiName": "feraligatr",
    "displayName": "Feraligatr",
    "isMega": false
  },
  {
    "id": 175,
    "apiName": "ariados",
    "displayName": "Ariados",
    "isMega": false
  },
  {
    "id": 180,
    "apiName": "ampharos",
    "displayName": "Ampharos",
    "isMega": false
  },
  {
    "id": 184,
    "apiName": "azumarill",
    "displayName": "Azumarill",
    "isMega": false
  },
  {
    "id": 189,
    "apiName": "politoed",
    "displayName": "Politoed",
    "isMega": false
  },
  {
    "id": 193,
    "apiName": "espeon",
    "displayName": "Espeon",
    "isMega": false
  },
  {
    "id": 197,
    "apiName": "umbreon",
    "displayName": "Umbreon",
    "isMega": false
  },
  {
    "id": 201,
    "apiName": "slowking",
    "displayName": "Slowking",
    "isMega": false
  },
  {
    "id": 211,
    "apiName": "forretress",
    "displayName": "Forretress",
    "isMega": false
  },
  {
    "id": 216,
    "apiName": "steelix",
    "displayName": "Steelix",
    "isMega": false
  },
  {
    "id": 221,
    "apiName": "scizor",
    "displayName": "Scizor",
    "isMega": false
  },
  {
    "id": 226,
    "apiName": "heracross",
    "displayName": "Heracross",
    "isMega": false
  },
  {
    "id": 231,
    "apiName": "skarmory",
    "displayName": "Skarmory",
    "isMega": false
  },
  {
    "id": 236,
    "apiName": "houndoom",
    "displayName": "Houndoom",
    "isMega": false
  },
  {
    "id": 241,
    "apiName": "tyranitar",
    "displayName": "Tyranitar",
    "isMega": false
  },
  {
    "id": 246,
    "apiName": "pelipper",
    "displayName": "Pelipper",
    "isMega": false
  },
  {
    "id": 251,
    "apiName": "gardevoir",
    "displayName": "Gardevoir",
    "isMega": false
  },
  {
    "id": 256,
    "apiName": "sableye",
    "displayName": "Sableye",
    "isMega": false
  },
  {
    "id": 261,
    "apiName": "aggron",
    "displayName": "Aggron",
    "isMega": false
  },
  {
    "id": 266,
    "apiName": "medicham",
    "displayName": "Medicham",
    "isMega": false
  },
  {
    "id": 271,
    "apiName": "manectric",
    "displayName": "Manectric",
    "isMega": false
  },
  {
    "id": 275,
    "apiName": "sharpedo",
    "displayName": "Sharpedo",
    "isMega": false
  },
  {
    "id": 280,
    "apiName": "camerupt",
    "displayName": "Camerupt",
    "isMega": false
  },
  {
    "id": 285,
    "apiName": "torkoal",
    "displayName": "Torkoal",
    "isMega": false
  },
  {
    "id": 289,
    "apiName": "altaria",
    "displayName": "Altaria",
    "isMega": false
  },
  {
    "id": 294,
    "apiName": "milotic",
    "displayName": "Milotic",
    "isMega": false
  },
  {
    "id": 298,
    "apiName": "castform",
    "displayName": "Castform",
    "isMega": false
  },
  {
    "id": 302,
    "apiName": "banette",
    "displayName": "Banette",
    "isMega": false
  },
  {
    "id": 306,
    "apiName": "chimecho",
    "displayName": "Chimecho",
    "isMega": false
  },
  {
    "id": 310,
    "apiName": "absol",
    "displayName": "Absol",
    "isMega": false
  },
  {
    "id": 314,
    "apiName": "glalie",
    "displayName": "Glalie",
    "isMega": false
  },
  {
    "id": 318,
    "apiName": "torterra",
    "displayName": "Torterra",
    "isMega": false
  },
  {
    "id": 323,
    "apiName": "infernape",
    "displayName": "Infernape",
    "isMega": false
  },
  {
    "id": 328,
    "apiName": "empoleon",
    "displayName": "Empoleon",
    "isMega": false
  },
  {
    "id": 333,
    "apiName": "luxray",
    "displayName": "Luxray",
    "isMega": false
  },
  {
    "id": 337,
    "apiName": "roserade",
    "displayName": "Roserade",
    "isMega": false
  },
  {
    "id": 342,
    "apiName": "rampardos",
    "displayName": "Rampardos",
    "isMega": false
  },
  {
    "id": 346,
    "apiName": "bastiodon",
    "displayName": "Bastiodon",
    "isMega": false
  },
  {
    "id": 351,
    "apiName": "lopunny",
    "displayName": "Lopunny",
    "isMega": false
  },
  {
    "id": 355,
    "apiName": "spiritomb",
    "displayName": "Spiritomb",
    "isMega": false
  },
  {
    "id": 360,
    "apiName": "garchomp",
    "displayName": "Garchomp",
    "isMega": false
  },
  {
    "id": 365,
    "apiName": "lucario",
    "displayName": "Lucario",
    "isMega": false
  },
  {
    "id": 370,
    "apiName": "hippowdon",
    "displayName": "Hippowdon",
    "isMega": false
  },
  {
    "id": 374,
    "apiName": "toxicroak",
    "displayName": "Toxicroak",
    "isMega": false
  },
  {
    "id": 379,
    "apiName": "abomasnow",
    "displayName": "Abomasnow",
    "isMega": false
  },
  {
    "id": 384,
    "apiName": "weavile",
    "displayName": "Weavile",
    "isMega": false
  },
  {
    "id": 389,
    "apiName": "rhyperior",
    "displayName": "Rhyperior",
    "isMega": false
  },
  {
    "id": 394,
    "apiName": "leafeon",
    "displayName": "Leafeon",
    "isMega": false
  },
  {
    "id": 398,
    "apiName": "glaceon",
    "displayName": "Glaceon",
    "isMega": false
  },
  {
    "id": 402,
    "apiName": "gliscor",
    "displayName": "Gliscor",
    "isMega": false
  },
  {
    "id": 407,
    "apiName": "mamoswine",
    "displayName": "Mamoswine",
    "isMega": false
  },
  {
    "id": 412,
    "apiName": "gallade",
    "displayName": "Gallade",
    "isMega": false
  },
  {
    "id": 417,
    "apiName": "froslass",
    "displayName": "Froslass",
    "isMega": false
  },
  {
    "id": 422,
    "apiName": "rotom",
    "displayName": "Rotom",
    "isMega": false
  },
  {
    "id": 427,
    "apiName": "serperior",
    "displayName": "Serperior",
    "isMega": false
  },
  {
    "id": 431,
    "apiName": "emboar",
    "displayName": "Emboar",
    "isMega": false
  },
  {
    "id": 436,
    "apiName": "samurott",
    "displayName": "Samurott",
    "isMega": false
  },
  {
    "id": 445,
    "apiName": "watchog",
    "displayName": "Watchog",
    "isMega": false
  },
  {
    "id": 449,
    "apiName": "liepard",
    "displayName": "Liepard",
    "isMega": false
  },
  {
    "id": 453,
    "apiName": "simisage",
    "displayName": "Simisage",
    "isMega": false
  },
  {
    "id": 457,
    "apiName": "simisear",
    "displayName": "Simisear",
    "isMega": false
  },
  {
    "id": 461,
    "apiName": "simipour",
    "displayName": "Simipour",
    "isMega": false
  },
  {
    "id": 465,
    "apiName": "excadrill",
    "displayName": "Excadrill",
    "isMega": false
  },
  {
    "id": 470,
    "apiName": "audino",
    "displayName": "Audino",
    "isMega": false
  },
  {
    "id": 474,
    "apiName": "conkeldurr",
    "displayName": "Conkeldurr",
    "isMega": false
  },
  {
    "id": 478,
    "apiName": "whimsicott",
    "displayName": "Whimsicott",
    "isMega": false
  },
  {
    "id": 483,
    "apiName": "krookodile",
    "displayName": "Krookodile",
    "isMega": false
  },
  {
    "id": 488,
    "apiName": "cofagrigus",
    "displayName": "Cofagrigus",
    "isMega": false
  },
  {
    "id": 492,
    "apiName": "garbodor",
    "displayName": "Garbodor",
    "isMega": false
  },
  {
    "id": 496,
    "apiName": "zoroark",
    "displayName": "Zoroark",
    "isMega": false
  },
  {
    "id": 505,
    "apiName": "reuniclus",
    "displayName": "Reuniclus",
    "isMega": false
  },
  {
    "id": 509,
    "apiName": "vanilluxe",
    "displayName": "Vanilluxe",
    "isMega": false
  },
  {
    "id": 513,
    "apiName": "emolga",
    "displayName": "Emolga",
    "isMega": false
  },
  {
    "id": 518,
    "apiName": "chandelure",
    "displayName": "Chandelure",
    "isMega": false
  },
  {
    "id": 523,
    "apiName": "beartic",
    "displayName": "Beartic",
    "isMega": false
  },
  {
    "id": 527,
    "apiName": "stunfisk",
    "displayName": "Stunfisk",
    "isMega": false
  },
  {
    "id": 537,
    "apiName": "golurk",
    "displayName": "Golurk",
    "isMega": false
  },
  {
    "id": 542,
    "apiName": "hydreigon",
    "displayName": "Hydreigon",
    "isMega": false
  },
  {
    "id": 547,
    "apiName": "volcarona",
    "displayName": "Volcarona",
    "isMega": false
  },
  {
    "id": 552,
    "apiName": "chesnaught",
    "displayName": "Chesnaught",
    "isMega": false
  },
  {
    "id": 557,
    "apiName": "delphox",
    "displayName": "Delphox",
    "isMega": false
  },
  {
    "id": 562,
    "apiName": "greninja",
    "displayName": "Greninja",
    "isMega": false
  },
  {
    "id": 567,
    "apiName": "diggersby",
    "displayName": "Diggersby",
    "isMega": false
  },
  {
    "id": 572,
    "apiName": "talonflame",
    "displayName": "Talonflame",
    "isMega": false
  },
  {
    "id": 577,
    "apiName": "vivillon",
    "displayName": "Vivillon",
    "isMega": false
  },
  {
    "id": 582,
    "apiName": "floette",
    "displayName": "Floette",
    "isMega": false
  },
  {
    "id": 586,
    "apiName": "florges",
    "displayName": "Florges",
    "isMega": false
  },
  {
    "id": 590,
    "apiName": "pangoro",
    "displayName": "Pangoro",
    "isMega": false
  },
  {
    "id": 595,
    "apiName": "furfrou",
    "displayName": "Furfrou",
    "isMega": false
  },
  {
    "id": 599,
    "apiName": "meowstic",
    "displayName": "Meowstic",
    "isMega": false
  },
  {
    "id": 603,
    "apiName": "aegislash",
    "displayName": "Aegislash",
    "isMega": false
  },
  {
    "id": 608,
    "apiName": "aromatisse",
    "displayName": "Aromatisse",
    "isMega": false
  },
  {
    "id": 612,
    "apiName": "slurpuff",
    "displayName": "Slurpuff",
    "isMega": false
  },
  {
    "id": 616,
    "apiName": "clawitzer",
    "displayName": "Clawitzer",
    "isMega": false
  },
  {
    "id": 620,
    "apiName": "heliolisk",
    "displayName": "Heliolisk",
    "isMega": false
  },
  {
    "id": 625,
    "apiName": "tyrantrum",
    "displayName": "Tyrantrum",
    "isMega": false
  },
  {
    "id": 630,
    "apiName": "aurorus",
    "displayName": "Aurorus",
    "isMega": false
  },
  {
    "id": 635,
    "apiName": "sylveon",
    "displayName": "Sylveon",
    "isMega": false
  },
  {
    "id": 639,
    "apiName": "hawlucha",
    "displayName": "Hawlucha",
    "isMega": false
  },
  {
    "id": 644,
    "apiName": "dedenne",
    "displayName": "Dedenne",
    "isMega": false
  },
  {
    "id": 649,
    "apiName": "goodra",
    "displayName": "Goodra",
    "isMega": false
  },
  {
    "id": 658,
    "apiName": "klefki",
    "displayName": "Klefki",
    "isMega": false
  },
  {
    "id": 663,
    "apiName": "trevenant",
    "displayName": "Trevenant",
    "isMega": false
  },
  {
    "id": 668,
    "apiName": "gourgeist",
    "displayName": "Gourgeist",
    "isMega": false
  },
  {
    "id": 673,
    "apiName": "avalugg",
    "displayName": "Avalugg",
    "isMega": false
  },
  {
    "id": 682,
    "apiName": "noivern",
    "displayName": "Noivern",
    "isMega": false
  },
  {
    "id": 687,
    "apiName": "decidueye",
    "displayName": "Decidueye",
    "isMega": false
  },
  {
    "id": 697,
    "apiName": "incineroar",
    "displayName": "Incineroar",
    "isMega": false
  },
  {
    "id": 702,
    "apiName": "primarina",
    "displayName": "Primarina",
    "isMega": false
  },
  {
    "id": 707,
    "apiName": "toucannon",
    "displayName": "Toucannon",
    "isMega": false
  },
  {
    "id": 712,
    "apiName": "crabominable",
    "displayName": "Crabominable",
    "isMega": false
  },
  {
    "id": 717,
    "apiName": "lycanroc",
    "displayName": "Lycanroc",
    "isMega": false
  },
  {
    "id": 721,
    "apiName": "toxapex",
    "displayName": "Toxapex",
    "isMega": false
  },
  {
    "id": 726,
    "apiName": "mudsdale",
    "displayName": "Mudsdale",
    "isMega": false
  },
  {
    "id": 730,
    "apiName": "araquanid",
    "displayName": "Araquanid",
    "isMega": false
  },
  {
    "id": 735,
    "apiName": "salazzle",
    "displayName": "Salazzle",
    "isMega": false
  },
  {
    "id": 740,
    "apiName": "tsareena",
    "displayName": "Tsareena",
    "isMega": false
  },
  {
    "id": 744,
    "apiName": "oranguru",
    "displayName": "Oranguru",
    "isMega": false
  },
  {
    "id": 749,
    "apiName": "passimian",
    "displayName": "Passimian",
    "isMega": false
  },
  {
    "id": 753,
    "apiName": "mimikyu",
    "displayName": "Mimikyu",
    "isMega": false
  },
  {
    "id": 758,
    "apiName": "drampa",
    "displayName": "Drampa",
    "isMega": false
  },
  {
    "id": 763,
    "apiName": "kommo-o",
    "displayName": "Kommo-o",
    "isMega": false
  },
  {
    "id": 768,
    "apiName": "corviknight",
    "displayName": "Corviknight",
    "isMega": false
  },
  {
    "id": 773,
    "apiName": "flapple",
    "displayName": "Flapple",
    "isMega": false
  },
  {
    "id": 778,
    "apiName": "appletun",
    "displayName": "Appletun",
    "isMega": false
  },
  {
    "id": 783,
    "apiName": "sandaconda",
    "displayName": "Sandaconda",
    "isMega": false
  },
  {
    "id": 787,
    "apiName": "polteageist",
    "displayName": "Polteageist",
    "isMega": false
  },
  {
    "id": 791,
    "apiName": "hatterene",
    "displayName": "Hatterene",
    "isMega": false
  },
  {
    "id": 796,
    "apiName": "mr-rime",
    "displayName": "Mr. Rime",
    "isMega": false
  },
  {
    "id": 801,
    "apiName": "runerigus",
    "displayName": "Runerigus",
    "isMega": false
  },
  {
    "id": 806,
    "apiName": "alcremie",
    "displayName": "Alcremie",
    "isMega": false
  },
  {
    "id": 810,
    "apiName": "morpeko",
    "displayName": "Morpeko",
    "isMega": false
  },
  {
    "id": 815,
    "apiName": "dragapult",
    "displayName": "Dragapult",
    "isMega": false
  },
  {
    "id": 820,
    "apiName": "wyrdeer",
    "displayName": "Wyrdeer",
    "isMega": false
  },
  {
    "id": 825,
    "apiName": "kleavor",
    "displayName": "Kleavor",
    "isMega": false
  },
  {
    "id": 830,
    "apiName": "basculegion",
    "displayName": "Basculegion",
    "isMega": false
  },
  {
    "id": 835,
    "apiName": "sneasler",
    "displayName": "Sneasler",
    "isMega": false
  },
  {
    "id": 840,
    "apiName": "meowscarada",
    "displayName": "Meowscarada",
    "isMega": false
  },
  {
    "id": 845,
    "apiName": "skeledirge",
    "displayName": "Skeledirge",
    "isMega": false
  },
  {
    "id": 850,
    "apiName": "quaquaval",
    "displayName": "Quaquaval",
    "isMega": false
  },
  {
    "id": 855,
    "apiName": "pawmot",
    "displayName": "Pawmot",
    "isMega": false
  },
  {
    "id": 860,
    "apiName": "maushold",
    "displayName": "Maushold",
    "isMega": false
  },
  {
    "id": 864,
    "apiName": "garganacl",
    "displayName": "Garganacl",
    "isMega": false
  },
  {
    "id": 868,
    "apiName": "armarouge",
    "displayName": "Armarouge",
    "isMega": false
  },
  {
    "id": 873,
    "apiName": "ceruledge",
    "displayName": "Ceruledge",
    "isMega": false
  },
  {
    "id": 878,
    "apiName": "bellibolt",
    "displayName": "Bellibolt",
    "isMega": false
  },
  {
    "id": 882,
    "apiName": "scovillain",
    "displayName": "Scovillain",
    "isMega": false
  },
  {
    "id": 887,
    "apiName": "espathra",
    "displayName": "Espathra",
    "isMega": false
  },
  {
    "id": 891,
    "apiName": "tinkaton",
    "displayName": "Tinkaton",
    "isMega": false
  },
  {
    "id": 896,
    "apiName": "palafin",
    "displayName": "Palafin",
    "isMega": false
  },
  {
    "id": 900,
    "apiName": "orthworm",
    "displayName": "Orthworm",
    "isMega": false
  },
  {
    "id": 904,
    "apiName": "glimmora",
    "displayName": "Glimmora",
    "isMega": false
  },
  {
    "id": 909,
    "apiName": "farigiraf",
    "displayName": "Farigiraf",
    "isMega": false
  },
  {
    "id": 914,
    "apiName": "kingambit",
    "displayName": "Kingambit",
    "isMega": false
  },
  {
    "id": 919,
    "apiName": "sinistcha",
    "displayName": "Sinistcha",
    "isMega": false
  },
  {
    "id": 924,
    "apiName": "archaludon",
    "displayName": "Archaludon",
    "isMega": false
  },
  {
    "id": 929,
    "apiName": "hydrapple",
    "displayName": "Hydrapple",
    "isMega": false
  },
  {
    "id": 934,
    "apiName": "vileplume",
    "displayName": "Vileplume",
    "isMega": false
  },
  {
    "id": 939,
    "apiName": "qwilfish",
    "displayName": "Qwilfish",
    "isMega": false
  },
  {
    "id": 944,
    "apiName": "sceptile",
    "displayName": "Sceptile",
    "isMega": false
  },
  {
    "id": 948,
    "apiName": "blaziken",
    "displayName": "Blaziken",
    "isMega": false
  },
  {
    "id": 953,
    "apiName": "swampert",
    "displayName": "Swampert",
    "isMega": false
  },
  {
    "id": 958,
    "apiName": "mawile",
    "displayName": "Mawile",
    "isMega": false
  },
  {
    "id": 963,
    "apiName": "metagross",
    "displayName": "Metagross",
    "isMega": false
  },
  {
    "id": 968,
    "apiName": "staraptor",
    "displayName": "Staraptor",
    "isMega": false
  },
  {
    "id": 973,
    "apiName": "musharna",
    "displayName": "Musharna",
    "isMega": false
  },
  {
    "id": 977,
    "apiName": "scolipede",
    "displayName": "Scolipede",
    "isMega": false
  },
  {
    "id": 982,
    "apiName": "scrafty",
    "displayName": "Scrafty",
    "isMega": false
  },
  {
    "id": 987,
    "apiName": "eelektross",
    "displayName": "Eelektross",
    "isMega": false
  },
  {
    "id": 991,
    "apiName": "pyroar",
    "displayName": "Pyroar",
    "isMega": false
  },
  {
    "id": 996,
    "apiName": "malamar",
    "displayName": "Malamar",
    "isMega": false
  },
  {
    "id": 1001,
    "apiName": "barbaracle",
    "displayName": "Barbaracle",
    "isMega": false
  },
  {
    "id": 1006,
    "apiName": "dragalge",
    "displayName": "Dragalge",
    "isMega": false
  },
  {
    "id": 1011,
    "apiName": "grimmsnarl",
    "displayName": "Grimmsnarl",
    "isMega": false
  },
  {
    "id": 1016,
    "apiName": "falinks",
    "displayName": "Falinks",
    "isMega": false
  },
  {
    "id": 1020,
    "apiName": "overqwil",
    "displayName": "Overqwil",
    "isMega": false
  },
  {
    "id": 1025,
    "apiName": "houndstone",
    "displayName": "Houndstone",
    "isMega": false
  },
  {
    "id": 1029,
    "apiName": "annihilape",
    "displayName": "Annihilape",
    "isMega": false
  },
  {
    "id": 1034,
    "apiName": "gholdengo",
    "displayName": "Gholdengo",
    "isMega": false
  },
  {
    "id": 1039,
    "apiName": "wigglytuff",
    "displayName": "Wigglytuff",
    "isMega": false
  },
  {
    "id": 1044,
    "apiName": "persian",
    "displayName": "Persian",
    "isMega": false
  },
  {
    "id": 1052,
    "apiName": "farfetchd",
    "displayName": "Farfetch'd",
    "isMega": false
  },
  {
    "id": 1057,
    "apiName": "mr-mime",
    "displayName": "Mr. Mime",
    "isMega": false
  },
  {
    "id": 1062,
    "apiName": "swalot",
    "displayName": "Swalot",
    "isMega": false
  },
  {
    "id": 1066,
    "apiName": "salamence",
    "displayName": "Salamence",
    "isMega": false
  },
  {
    "id": 1071,
    "apiName": "gogoat",
    "displayName": "Gogoat",
    "isMega": false
  },
  {
    "id": 1075,
    "apiName": "golisopod",
    "displayName": "Golisopod",
    "isMega": false
  },
  {
    "id": 1080,
    "apiName": "rillaboom",
    "displayName": "Rillaboom",
    "isMega": false
  },
  {
    "id": 1084,
    "apiName": "cinderace",
    "displayName": "Cinderace",
    "isMega": false
  },
  {
    "id": 1088,
    "apiName": "inteleon",
    "displayName": "Inteleon",
    "isMega": false
  },
  {
    "id": 1092,
    "apiName": "thievul",
    "displayName": "Thievul",
    "isMega": false
  },
  {
    "id": 1096,
    "apiName": "toxtricity",
    "displayName": "Toxtricity",
    "isMega": false
  },
  {
    "id": 1101,
    "apiName": "grapploct",
    "displayName": "Grapploct",
    "isMega": false
  },
  {
    "id": 1105,
    "apiName": "perrserker",
    "displayName": "Perrserker",
    "isMega": false
  },
  {
    "id": 1109,
    "apiName": "sirfetchd",
    "displayName": "Sirfetch'd",
    "isMega": false
  },
  {
    "id": 1113,
    "apiName": "pincurchin",
    "displayName": "Pincurchin",
    "isMega": false
  },
  {
    "id": 1117,
    "apiName": "indeedee",
    "displayName": "Indeedee",
    "isMega": false
  },
  {
    "id": 1122,
    "apiName": "arboliva",
    "displayName": "Arboliva",
    "isMega": false
  },
  {
    "id": 1127,
    "apiName": "squawkabilly",
    "displayName": "Squawkabilly",
    "isMega": false
  },
  {
    "id": 1132,
    "apiName": "mabosstiff",
    "displayName": "Mabosstiff",
    "isMega": false
  },
  {
    "id": 1136,
    "apiName": "baxcalibur",
    "displayName": "Baxcalibur",
    "isMega": false
  },
