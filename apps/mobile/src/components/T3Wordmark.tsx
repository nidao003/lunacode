import type { ColorValue } from "react-native";
import Svg, { Path } from "react-native-svg";
import { withUniwind } from "uniwind";

const ThemedPath = withUniwind(Path);

export function T3Wordmark(props: {
  readonly height: number;
  readonly color?: ColorValue;
  readonly colorClassName?: string;
}) {
  return (
    <Svg
      accessibilityLabel="LunaCode"
      height={props.height}
      width={props.height}
      viewBox="0 0 24 24"
    >
      <ThemedPath
        d="M12.65 3.52A8.6 8.6 0 1 0 17.18 18.23A7.7 7.7 0 0 1 12.65 3.52ZM18 5.6L18.95 8.05L21.4 9L18.95 9.95L18 12.4L17.05 9.95L14.6 9L17.05 8.05Z"
        color={props.color}
        colorClassName={props.colorClassName}
        fill="currentColor"
      />
    </Svg>
  );
}
