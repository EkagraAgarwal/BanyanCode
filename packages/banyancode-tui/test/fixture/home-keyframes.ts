// Copied from specs/tui-redesign-handoff/keyframes: line N is terminal row N-1, so these
// are the bottom ten tree rows and the wordmark, at the terminal position the mockup draws.
export const TREE_COLUMNS = 100
export const WORDMARK_COLUMNS = 59
/** home-6s.txt lines 15-24, columns 34-133. */
export const TREE_ROWS_AT_6 = [
  "                    ⡸⡇ ⢸ ⡇  ⣿ ⢸  ⢸         ⢸   ⣿⣿⣿⣿⣿⣿⡇      ⢸     ⡇  ⢣⡇⡏  ⡇  ⢸ ⡇ ⡇    ⡇",
  "                    ⡇⡇ ⢸ ⣇ ⢸⢸ ⢸  ⢸         ⢸   ⣿⣿⣿⣿⣿⣿⡇      ⢸     ⡇  ⢸⡇⡇  ⡇  ⢸ ⡇ ⡇    ⡇",
  "                    ⡇⡇ ⢸⢸⢸ ⢸⢸ ⢸  ⢸         ⢸  ⢰⡟⣿⣿⣿⣿⡟⣷      ⢸     ⡇  ⢸⡇⡇  ⡇  ⢸ ⡇ ⡇    ⡇",
  "                    ⡇⡇ ⢸⢸⢸ ⢸⢸ ⢸  ⢸         ⢸  ⣸⣿⡎⣿⣿⡏⣾⣿⡀     ⢸     ⡇  ⢸⡇⡇  ⡇  ⢸ ⡇ ⡇    ⡇",
  "                    ⡇⡇ ⢸⢸⢸ ⢸⢸ ⢸  ⢸         ⢸  ⣧⡻⣿⢸⣿⢸⡿⣣⡇     ⢸     ⡇  ⢸⡇⡇  ⡇  ⢸ ⡇ ⡇   ⢀⠇",
  "                    ⡇⡇ ⢸⢸⢸ ⢸⢸ ⢸  ⢸         ⢸ ⢸⡹⣧⢿⡼⡿⣼⢧⡿⣹     ⢸     ⡇  ⢸⡇⡇  ⡇  ⢸ ⡇ ⡇   ⠘⡄",
  "                    ⡇⡇ ⢸⢸⢸ ⢸⢸ ⢸  ⢸         ⢸ ⣇⢷⢻⣸⡇⡇⣿⣸⢳⢇⡇    ⢸     ⡇  ⢸⡇⡇  ⡇  ⢸ ⡇ ⡇    ⡇",
  "                    ⢸⡇ ⢸⠘⣼ ⢸⢸ ⢸  ⢸         ⢸⡸⡼⡜⡞⡇⡇⡇⡇⡟⡞⡼⡼⡀   ⢸     ⡇  ⡸⡇⢧  ⡇  ⢸ ⡇ ⡇    ⡇",
  "                    ⢸⡇ ⢸ ⣿ ⢸⢸ ⢸  ⠸⡀        ⢸⢣⢃⢇⠇⡇⡇⡇⡇⡇⢇⢇⢣⢣   ⢸     ⡇  ⡇⡇⢸  ⡇  ⢸ ⡇ ⡇    ⡇",
  "                    ⠸⠇ ⠸ ⠇ ⠘⠼ ⠸   ⠇        ⠿⠎⠜⠸⠸ ⠇⠇⠇⠸⠸⠘⠌⠆⠇  ⠸     ⠇  ⠇⠇⠸  ⠇  ⠸ ⠇ ⠇    ⠇",
]

/** home-2.2s.txt lines 15-24, columns 34-133. */
export const TREE_ROWS_AT_2_2 = [
  "                                               ⣿⣿⣿⣿⣿⣿⡇",
  "                                               ⣿⣿⣿⣿⣿⣿⡇",
  "                                              ⢰⡟⣿⣿⣿⣿⡟⣷",
  "                                              ⣸⣿⡎⣿⣿⡏⣾⣿⡀",
  "                                              ⣧⡻⣿⢸⣿⢸⡿⣣⡇",
  "                                             ⢸⡹⣧⢿⡼⡿⣼⢧⡿⣹",
  "                                             ⣇⢷⢻⣸⡇⡇⣿⣸⢳⢇⡇",
  "                                            ⡸⡼⡜⡞⡇⡇⡇⡇⡟⡞⡼⡼⡀",
  "                                           ⢠⢣⢃⢇⠇⡇⡇⡇⡇⡇⢇⢇⢣⢣",
  "                                           ⠇⠎⠜⠸⠸ ⠇⠇⠇⠸⠸⠘⠌⠆⠇",
]

/** home-6s.txt lines 27-30, columns 55-113. */
export const WORDMARK_ROWS_AT_6 = [
  "█▀▀▀▄ ▄▀▀▀▄ █▄  █ █   █ ▄▀▀▀▄ █▄  █ ▄▀▀▀▀ ▄▀▀▀▄ █▀▀▀▄ █▀▀▀▀",
  "█▄▄▄▀ █▄▄▄█ █ █ █  ▀▄▀  █▄▄▄█ █ █ █ █     █   █ █   █ █▄▄▄",
  "█   █ █   █ █ ▀▄█   █   █   █ █ ▀▄█ █     █   █ █   █ █",
  "▀▀▀▀  ▀   ▀ ▀   ▀   ▀   ▀   ▀ ▀   ▀  ▀▀▀▀  ▀▀▀  ▀▀▀▀  ▀▀▀▀▀",
]
