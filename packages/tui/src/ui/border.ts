export const EmptyBorder = {
  topLeft: "",
  bottomLeft: "",
  vertical: "",
  topRight: "",
  bottomRight: "",
  horizontal: " ",
  bottomT: "",
  topT: "",
  cross: "",
  leftT: "",
  rightT: "",
}

export const SplitBorder = {
  border: ["left" as const, "right" as const],
  customBorderChars: {
    ...EmptyBorder,
    vertical: "┃",
  },
}

export const RoundedBorder = {
  customBorderChars: {
    ...EmptyBorder,
    topLeft: "╭",
    topRight: "╮",
    bottomLeft: "╰",
    bottomRight: "╯",
    horizontal: "─",
    vertical: "│",
    topT: "┬",
    bottomT: "┴",
    leftT: "├",
    rightT: "┤",
    cross: "┼",
  },
}

export const RoundedTopBorder = {
  customBorderChars: {
    ...RoundedBorder.customBorderChars,
    bottomLeft: "",
    bottomRight: "",
    bottomT: "",
  },
}

export const RoundedBottomBorder = {
  customBorderChars: {
    ...RoundedBorder.customBorderChars,
    topLeft: "",
    topRight: "",
    topT: "",
  },
}

export const DashedDividerChars = {
  horizontal: "╌",
}
