import { View } from "react-native";

import { AppText as Text } from "../components/ui/AppText";

export function LunaMobileTurnSpeedBadge(props: {
  readonly tokensPerSecond: number | null | undefined;
}) {
  if (
    props.tokensPerSecond === null ||
    props.tokensPerSecond === undefined ||
    !Number.isFinite(props.tokensPerSecond) ||
    props.tokensPerSecond <= 0
  ) {
    return null;
  }

  return (
    <View className="rounded-md border border-border-subtle bg-subtle px-1.5 py-0.5">
      <Text className="font-mono text-2xs tabular-nums text-foreground-secondary">
        {props.tokensPerSecond.toFixed(1)} tok/s
      </Text>
    </View>
  );
}
