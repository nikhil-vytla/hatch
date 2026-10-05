/** The fictional café menu the agent experiments choose a drink from: each drink's facts. */
export const drinkMenu: Record<string, Record<string, boolean>> = {
  espresso: { hot: true, caffeine: true, dairy: false, sweet: false },
  latte: { hot: true, caffeine: true, dairy: true, sweet: false },
  iced_coffee: { hot: false, caffeine: true, dairy: false, sweet: false },
  iced_latte: { hot: false, caffeine: true, dairy: true, sweet: false },
  herbal_tea: { hot: true, caffeine: false, dairy: false, sweet: false },
  hot_chocolate: { hot: true, caffeine: false, dairy: true, sweet: true },
  lemonade: { hot: false, caffeine: false, dairy: false, sweet: true },
  milkshake: { hot: false, caffeine: false, dairy: true, sweet: true },
};
