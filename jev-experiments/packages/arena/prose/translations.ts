/**
 * The canonical question and the prose facts of every truth item, translated by hand (no model
 * was called). Values stay as written in English where they are numbers, times, dates, names or
 * the password, so only the language changes.
 */

export const LANGUAGES = ["es", "fr", "de", "zh", "ja", "hi", "ar"] as const;

export type Language = (typeof LANGUAGES)[number];

export type Translation = { question: string; prose: string };

export const TRANSLATIONS: Record<string, Record<Language, Translation>> = {
  parcel: {
    es: {
      question: "¿Está el paquete dentro del límite de peso del envío estándar?",
      prose: "El paquete pesa 3.2 kg y va a Leeds. El envío estándar acepta paquetes de hasta 5 kg.",
    },
    fr: {
      question: "Le colis respecte-t-il la limite de poids de la livraison standard ?",
      prose: "Le colis pèse 3.2 kg et part pour Leeds. La livraison standard accepte les colis jusqu'à 5 kg.",
    },
    de: {
      question: "Liegt das Paket innerhalb der Gewichtsgrenze für den Standardversand?",
      prose: "Das Paket wiegt 3.2 kg und geht nach Leeds. Der Standardversand nimmt Pakete bis 5 kg an.",
    },
    zh: {
      question: "这个包裹是否在标准运输的重量限制之内？",
      prose: "这个包裹重 3.2 kg，寄往利兹（Leeds）。标准运输接受不超过 5 kg 的包裹。",
    },
    ja: {
      question: "この小包は通常配送の重量制限内ですか？",
      prose: "小包の重さは 3.2 kg で、リーズ（Leeds）宛てです。通常配送は 5 kg までの小包を受け付けます。",
    },
    hi: {
      question: "क्या पार्सल मानक शिपिंग की वज़न सीमा के भीतर है?",
      prose: "पार्सल का वज़न 3.2 kg है और यह लीड्स (Leeds) जा रहा है। मानक शिपिंग 5 kg तक के पार्सल स्वीकार करती है।",
    },
    ar: {
      question: "هل الطرد ضمن حدّ الوزن المسموح به للشحن العادي؟",
      prose: "يزن الطرد 3.2 kg ومتجه إلى ليدز (Leeds). يقبل الشحن العادي الطرود حتى 5 kg.",
    },
  },
  refund: {
    es: {
      question: "¿Tiene el cliente derecho a un reembolso?",
      prose:
        "El cliente compró el artículo el 2026-08-02 y pidió un reembolso el 2026-09-10. El artículo está sin abrir. Se permiten reembolsos dentro de los 30 días posteriores a la compra.",
    },
    fr: {
      question: "Le client a-t-il droit à un remboursement ?",
      prose:
        "Le client a acheté l'article le 2026-08-02 et a demandé un remboursement le 2026-09-10. L'article n'a pas été ouvert. Les remboursements sont acceptés dans les 30 jours suivant l'achat.",
    },
    de: {
      question: "Hat der Kunde Anspruch auf eine Rückerstattung?",
      prose:
        "Der Kunde hat den Artikel am 2026-08-02 gekauft und am 2026-09-10 eine Rückerstattung verlangt. Der Artikel ist ungeöffnet. Rückerstattungen sind innerhalb von 30 Tagen nach dem Kauf möglich.",
    },
    zh: {
      question: "这位顾客有资格获得退款吗？",
      prose: "顾客于 2026-08-02 购买了这件商品，并于 2026-09-10 申请退款。商品未开封。购买后 30 天内可以退款。",
    },
    ja: {
      question: "この顧客は返金を受ける資格がありますか？",
      prose:
        "顧客は 2026-08-02 に商品を購入し、2026-09-10 に返金を求めました。商品は未開封です。返金は購入から 30 日以内に限り認められます。",
    },
    hi: {
      question: "क्या ग्राहक रिफ़ंड पाने का हक़दार है?",
      prose:
        "ग्राहक ने सामान 2026-08-02 को खरीदा और 2026-09-10 को रिफ़ंड माँगा। सामान खोला नहीं गया है। खरीद के 30 दिनों के भीतर रिफ़ंड की अनुमति है।",
    },
    ar: {
      question: "هل يحق للعميل استرداد المبلغ؟",
      prose:
        "اشترى العميل السلعة في 2026-08-02 وطلب استرداد المبلغ في 2026-09-10. السلعة غير مفتوحة. يُسمح بالاسترداد خلال 30 يومًا من تاريخ الشراء.",
    },
  },
  rental: {
    es: {
      question: "¿Tiene el conductor edad suficiente para alquilar un coche?",
      prose: "El conductor tiene 23 años y tiene carné de conducir desde hace 5 años. La edad mínima para alquilar un coche es 25.",
    },
    fr: {
      question: "Le conducteur a-t-il l'âge requis pour louer une voiture ?",
      prose: "Le conducteur a 23 ans et a son permis depuis 5 ans. L'âge minimum pour louer une voiture est de 25 ans.",
    },
    de: {
      question: "Ist der Fahrer alt genug, um ein Auto zu mieten?",
      prose: "Der Fahrer ist 23 und hat seit 5 Jahren einen Führerschein. Das Mindestalter für eine Automiete ist 25.",
    },
    zh: {
      question: "这位司机的年龄够租车吗？",
      prose: "司机 23 岁，已持有驾照 5 年。租车的最低年龄是 25 岁。",
    },
    ja: {
      question: "この運転者は車を借りられる年齢に達していますか？",
      prose: "運転者は 23 歳で、運転免許を取得して 5 年です。車を借りられる最低年齢は 25 歳です。",
    },
    hi: {
      question: "क्या ड्राइवर की उम्र कार किराए पर लेने के लिए काफ़ी है?",
      prose: "ड्राइवर 23 साल का है और उसके पास 5 साल से ड्राइविंग लाइसेंस है। कार किराए पर लेने की न्यूनतम उम्र 25 है।",
    },
    ar: {
      question: "هل بلغ السائق السن الكافية لاستئجار سيارة؟",
      prose: "عمر السائق 23 عامًا ويحمل رخصة قيادة منذ 5 سنوات. الحد الأدنى لسن استئجار سيارة هو 25.",
    },
  },
  cart: {
    es: {
      question: "¿Caben los tres artículos juntos dentro del presupuesto?",
      prose: "El carrito contiene un soporte para portátil de $45, un teclado de $79 y un ratón de $32. El presupuesto es de $160.",
    },
    fr: {
      question: "Les trois articles ensemble rentrent-ils dans le budget ?",
      prose: "Le panier contient un support d'ordinateur à $45, un clavier à $79 et une souris à $32. Le budget est de $160.",
    },
    de: {
      question: "Passen die drei Artikel zusammen ins Budget?",
      prose: "Im Warenkorb liegen ein Laptopständer für $45, eine Tastatur für $79 und eine Maus für $32. Das Budget beträgt $160.",
    },
    zh: {
      question: "这三件商品加起来在预算之内吗？",
      prose: "购物车里有一个 $45 的笔记本支架、一个 $79 的键盘和一个 $32 的鼠标。预算是 $160。",
    },
    ja: {
      question: "3つの商品を合わせて予算内に収まりますか？",
      prose: "カートには $45 のノートパソコンスタンド、$79 のキーボード、$32 のマウスが入っています。予算は $160 です。",
    },
    hi: {
      question: "क्या तीनों सामान मिलाकर बजट के भीतर आते हैं?",
      prose: "कार्ट में $45 का लैपटॉप स्टैंड, $79 का कीबोर्ड और $32 का माउस है। बजट $160 है।",
    },
    ar: {
      question: "هل تقع السلع الثلاث معًا ضمن الميزانية؟",
      prose: "تحتوي السلة على حامل حاسوب بسعر $45 ولوحة مفاتيح بسعر $79 وفأرة بسعر $32. الميزانية $160.",
    },
  },
  hotel: {
    es: {
      question: "¿Cabe la estancia en el hotel dentro del presupuesto?",
      prose: "El hotel cuesta $210 por noche durante 3 noches. El presupuesto de hotel para el viaje es de $600.",
    },
    fr: {
      question: "Le séjour à l'hôtel rentre-t-il dans le budget ?",
      prose: "L'hôtel coûte $210 la nuit pendant 3 nuits. Le budget hôtel du voyage est de $600.",
    },
    de: {
      question: "Passt der Hotelaufenthalt ins Budget?",
      prose: "Das Hotel kostet $210 pro Nacht für 3 Nächte. Das Hotelbudget für die Reise beträgt $600.",
    },
    zh: {
      question: "这次酒店住宿在预算之内吗？",
      prose: "酒店每晚 $210，住 3 晚。这次旅行的酒店预算是 $600。",
    },
    ja: {
      question: "このホテルの宿泊は予算内に収まりますか？",
      prose: "ホテルは1泊 $210 で、3 泊します。旅行のホテル予算は $600 です。",
    },
    hi: {
      question: "क्या होटल में ठहरना बजट के भीतर है?",
      prose: "होटल का किराया $210 प्रति रात है, 3 रातों के लिए। यात्रा का होटल बजट $600 है।",
    },
    ar: {
      question: "هل تقع الإقامة في الفندق ضمن الميزانية؟",
      prose: "يكلف الفندق $210 لليلة الواحدة لمدة 3 ليالٍ. ميزانية الفندق للرحلة $600.",
    },
  },
  meetings: {
    es: {
      question: "¿Se solapan las dos reuniones?",
      prose: "La reunión A es de 14:00 a 15:00 y la reunión B de 14:30 a 15:30, las dos el martes.",
    },
    fr: {
      question: "Les deux réunions se chevauchent-elles ?",
      prose: "La réunion A a lieu de 14:00 à 15:00 et la réunion B de 14:30 à 15:30, toutes deux le mardi.",
    },
    de: {
      question: "Überschneiden sich die beiden Besprechungen?",
      prose: "Besprechung A dauert von 14:00 bis 15:00 und Besprechung B von 14:30 bis 15:30, beide am Dienstag.",
    },
    zh: {
      question: "这两个会议时间有重叠吗？",
      prose: "会议 A 从 14:00 到 15:00，会议 B 从 14:30 到 15:30，都在星期二。",
    },
    ja: {
      question: "2つの会議は時間が重なっていますか？",
      prose: "会議 A は 14:00 から 15:00 まで、会議 B は 14:30 から 15:30 までで、どちらも火曜日です。",
    },
    hi: {
      question: "क्या दोनों मीटिंग का समय आपस में टकराता है?",
      prose: "मीटिंग A 14:00 से 15:00 तक और मीटिंग B 14:30 से 15:30 तक है, दोनों मंगलवार को।",
    },
    ar: {
      question: "هل يتداخل موعدا الاجتماعين؟",
      prose: "الاجتماع A من 14:00 إلى 15:00 والاجتماع B من 14:30 إلى 15:30، وكلاهما يوم الثلاثاء.",
    },
  },
  deadline: {
    es: {
      question: "¿Se entregó la tarea antes de la fecha límite?",
      prose: "La fecha límite es el viernes a las 17:00. El equipo de diseño entregó la tarea el viernes a las 18:00.",
    },
    fr: {
      question: "La tâche a-t-elle été rendue avant la date limite ?",
      prose: "La date limite est vendredi 17:00. L'équipe de design a rendu la tâche vendredi à 18:00.",
    },
    de: {
      question: "Wurde die Aufgabe vor der Frist abgegeben?",
      prose: "Die Frist ist Freitag 17:00. Das Designteam hat die Aufgabe am Freitag um 18:00 abgegeben.",
    },
    zh: {
      question: "这项任务是在截止时间之前提交的吗？",
      prose: "截止时间是星期五 17:00。设计团队在星期五 18:00 提交了任务。",
    },
    ja: {
      question: "このタスクは締め切り前に提出されましたか？",
      prose: "締め切りは金曜日の 17:00 です。デザインチームは金曜日の 18:00 にタスクを提出しました。",
    },
    hi: {
      question: "क्या काम समय-सीमा से पहले जमा किया गया था?",
      prose: "समय-सीमा शुक्रवार 17:00 है। डिज़ाइन टीम ने काम शुक्रवार 18:00 बजे जमा किया।",
    },
    ar: {
      question: "هل سُلّمت المهمة قبل الموعد النهائي؟",
      prose: "الموعد النهائي يوم الجمعة الساعة 17:00. سلّم فريق التصميم المهمة يوم الجمعة الساعة 18:00.",
    },
  },
  weather: {
    es: {
      question: "¿Hace más calor hoy en Madrid que en Oslo?",
      prose: "La máxima de hoy es de 12 °C en Oslo y de 27 °C en Madrid.",
    },
    fr: {
      question: "Fait-il plus chaud aujourd'hui à Madrid qu'à Oslo ?",
      prose: "La température maximale aujourd'hui est de 12 °C à Oslo et de 27 °C à Madrid.",
    },
    de: {
      question: "Ist es heute in Madrid wärmer als in Oslo?",
      prose: "Die Höchsttemperatur liegt heute in Oslo bei 12 °C und in Madrid bei 27 °C.",
    },
    zh: {
      question: "今天马德里比奥斯陆暖和吗？",
      prose: "今天奥斯陆的最高气温是 12 °C，马德里是 27 °C。",
    },
    ja: {
      question: "今日はマドリードのほうがオスロより暖かいですか？",
      prose: "今日の最高気温はオスロが 12 °C、マドリードが 27 °C です。",
    },
    hi: {
      question: "क्या आज मैड्रिड ओस्लो से ज़्यादा गर्म है?",
      prose: "आज ओस्लो का अधिकतम तापमान 12 °C और मैड्रिड का 27 °C है।",
    },
    ar: {
      question: "هل مدريد أدفأ من أوسلو اليوم؟",
      prose: "درجة الحرارة العظمى اليوم 12 °C في أوسلو و27 °C في مدريد.",
    },
  },
  "guide-dog": {
    es: {
      question: "¿Se permite la entrada del perro de la visitante en la cafetería?",
      prose: "La norma de la cafetería es: no se admiten perros, excepto perros guía. Una visitante llega con su perro guía.",
    },
    fr: {
      question: "Le chien de la visiteuse est-il autorisé dans le café ?",
      prose: "Le règlement du café est : chiens interdits, sauf les chiens guides. Une visiteuse arrive avec son chien guide.",
    },
    de: {
      question: "Darf der Hund der Besucherin ins Café?",
      prose: "Die Regel des Cafés lautet: keine Hunde, außer Blindenhunde. Eine Besucherin kommt mit ihrem Blindenhund.",
    },
    zh: {
      question: "这位访客的狗可以进入咖啡馆吗？",
      prose: "咖啡馆的规定是：禁止带狗入内，导盲犬除外。一位访客带着她的导盲犬来了。",
    },
    ja: {
      question: "この来店者の犬はカフェに入れますか？",
      prose: "カフェの規則は「犬の入店禁止、ただし盲導犬を除く」です。来店者が盲導犬を連れてやって来ました。",
    },
    hi: {
      question: "क्या आगंतुक का कुत्ता कैफ़े में आ सकता है?",
      prose: "कैफ़े का नियम है: कुत्तों का आना मना है, गाइड डॉग को छोड़कर। एक आगंतुक अपने गाइड डॉग के साथ आती है।",
    },
    ar: {
      question: "هل يُسمح بدخول كلب الزائرة إلى المقهى؟",
      prose: "سياسة المقهى: يُمنع دخول الكلاب، باستثناء الكلاب المرشدة. تصل زائرة ومعها كلبها المرشد.",
    },
  },
  delivery: {
    es: {
      question: "¿Tiene el pedido envío gratuito?",
      prose:
        "La política de envío es: envío gratuito en pedidos de más de $50, excepto muebles. El pedido es un sofá y el total del pedido es de $400.",
    },
    fr: {
      question: "La commande bénéficie-t-elle de la livraison gratuite ?",
      prose:
        "La politique de livraison est : livraison gratuite pour les commandes de plus de $50, sauf les meubles. La commande est un canapé, pour un total de $400.",
    },
    de: {
      question: "Bekommt die Bestellung kostenlose Lieferung?",
      prose:
        "Die Lieferbedingung lautet: kostenlose Lieferung bei Bestellungen über $50, außer Möbel. Die Bestellung ist ein Sofa, der Bestellwert beträgt $400.",
    },
    zh: {
      question: "这个订单可以享受免费配送吗？",
      prose: "配送政策是：订单满 $50 免费配送，家具除外。订单是一张沙发，订单总额为 $400。",
    },
    ja: {
      question: "この注文は送料無料になりますか？",
      prose: "配送規定は「$50 を超える注文は送料無料、ただし家具を除く」です。注文はソファ1台で、合計は $400 です。",
    },
    hi: {
      question: "क्या इस ऑर्डर को मुफ़्त डिलीवरी मिलेगी?",
      prose: "डिलीवरी नीति है: $50 से ज़्यादा के ऑर्डर पर मुफ़्त डिलीवरी, फ़र्नीचर को छोड़कर। ऑर्डर एक सोफ़ा है, और ऑर्डर का कुल मूल्य $400 है।",
    },
    ar: {
      question: "هل يحصل الطلب على توصيل مجاني؟",
      prose: "سياسة التوصيل: توصيل مجاني للطلبات التي تزيد على $50، باستثناء الأثاث. الطلب أريكة واحدة، وإجمالي الطلب $400.",
    },
  },
  training: {
    es: {
      question: "¿Han completado la formación todos los miembros del equipo?",
      prose: "El equipo lo forman Ana, Ben, Chen y Dita. Ana, Ben y Dita han completado la formación; la de Chen está pendiente.",
    },
    fr: {
      question: "Tous les membres de l'équipe ont-ils terminé la formation ?",
      prose: "L'équipe se compose d'Ana, Ben, Chen et Dita. Ana, Ben et Dita ont terminé la formation ; celle de Chen est en attente.",
    },
    de: {
      question: "Haben alle Teammitglieder die Schulung abgeschlossen?",
      prose: "Das Team besteht aus Ana, Ben, Chen und Dita. Ana, Ben und Dita haben die Schulung abgeschlossen; Chens Schulung steht noch aus.",
    },
    zh: {
      question: "团队的每位成员都完成培训了吗？",
      prose: "团队成员是 Ana、Ben、Chen 和 Dita。Ana、Ben 和 Dita 已完成培训；Chen 的培训尚未完成。",
    },
    ja: {
      question: "チームの全員が研修を修了しましたか？",
      prose: "チームは Ana、Ben、Chen、Dita の4人です。Ana、Ben、Dita は研修を修了しました。Chen の研修は未完了です。",
    },
    hi: {
      question: "क्या टीम के हर सदस्य ने प्रशिक्षण पूरा कर लिया है?",
      prose: "टीम में Ana, Ben, Chen और Dita हैं। Ana, Ben और Dita ने प्रशिक्षण पूरा कर लिया है; Chen का प्रशिक्षण बाकी है।",
    },
    ar: {
      question: "هل أكمل كل أعضاء الفريق التدريب؟",
      prose: "يتكون الفريق من Ana وBen وChen وDita. أكملت Ana وBen وDita التدريب، أما تدريب Chen فلم يكتمل بعد.",
    },
  },
  batches: {
    es: {
      question: "¿Falló la prueba al menos un lote?",
      prose: "Se probaron tres lotes. El lote 1 aprobó, el lote 2 falló y el lote 3 aprobó.",
    },
    fr: {
      question: "Au moins un lot a-t-il échoué au test ?",
      prose: "Trois lots ont été testés. Le lot 1 a réussi, le lot 2 a échoué et le lot 3 a réussi.",
    },
    de: {
      question: "Ist mindestens eine Charge durch den Test gefallen?",
      prose: "Drei Chargen wurden getestet. Charge 1 hat bestanden, Charge 2 ist durchgefallen und Charge 3 hat bestanden.",
    },
    zh: {
      question: "是否至少有一个批次未通过测试？",
      prose: "测试了三个批次。第 1 批通过，第 2 批未通过，第 3 批通过。",
    },
    ja: {
      question: "少なくとも1つのロットが検査に不合格でしたか？",
      prose: "3つのロットを検査しました。ロット 1 は合格、ロット 2 は不合格、ロット 3 は合格でした。",
    },
    hi: {
      question: "क्या कम से कम एक बैच परीक्षण में फ़ेल हुआ?",
      prose: "तीन बैचों का परीक्षण हुआ। बैच 1 पास हुआ, बैच 2 फ़ेल हुआ और बैच 3 पास हुआ।",
    },
    ar: {
      question: "هل فشلت دفعة واحدة على الأقل في الاختبار؟",
      prose: "اختُبرت ثلاث دفعات. نجحت الدفعة 1، وفشلت الدفعة 2، ونجحت الدفعة 3.",
    },
  },
  dolphin: {
    es: {
      question: "¿Es el animal un mamífero?",
      prose: "El animal es un delfín. Vive en el océano y come peces.",
    },
    fr: {
      question: "L'animal est-il un mammifère ?",
      prose: "L'animal est un dauphin. Il vit dans l'océan et mange des poissons.",
    },
    de: {
      question: "Ist das Tier ein Säugetier?",
      prose: "Das Tier ist ein Delfin. Er lebt im Ozean und frisst Fisch.",
    },
    zh: {
      question: "这种动物是哺乳动物吗？",
      prose: "这种动物是海豚。它生活在海洋里，以鱼为食。",
    },
    ja: {
      question: "この動物は哺乳類ですか？",
      prose: "この動物はイルカです。海に住み、魚を食べます。",
    },
    hi: {
      question: "क्या यह जानवर स्तनधारी है?",
      prose: "यह जानवर डॉल्फ़िन है। यह समुद्र में रहता है और मछलियाँ खाता है।",
    },
    ar: {
      question: "هل هذا الحيوان من الثدييات؟",
      prose: "الحيوان دلفين. يعيش في المحيط ويتغذى على الأسماك.",
    },
  },
  capital: {
    es: {
      question: "¿Es la ciudad la capital de su país?",
      prose: "La ciudad es Sídney, en Australia. Allí viven unos 5 millones de personas.",
    },
    fr: {
      question: "La ville est-elle la capitale de son pays ?",
      prose: "La ville est Sydney, en Australie. Environ 5 millions de personnes y vivent.",
    },
    de: {
      question: "Ist die Stadt die Hauptstadt ihres Landes?",
      prose: "Die Stadt ist Sydney in Australien. Dort leben etwa 5 Millionen Menschen.",
    },
    zh: {
      question: "这座城市是其国家的首都吗？",
      prose: "这座城市是澳大利亚的悉尼，约有 500 万人居住。",
    },
    ja: {
      question: "この都市はその国の首都ですか？",
      prose: "この都市はオーストラリアのシドニーです。約 500 万人が住んでいます。",
    },
    hi: {
      question: "क्या यह शहर अपने देश की राजधानी है?",
      prose: "यह शहर ऑस्ट्रेलिया का सिडनी है। वहाँ लगभग 5 मिलियन लोग रहते हैं।",
    },
    ar: {
      question: "هل هذه المدينة عاصمة بلدها؟",
      prose: "المدينة هي سيدني في أستراليا. يعيش فيها نحو 5 ملايين نسمة.",
    },
  },
  race: {
    es: {
      question: "¿Terminó Lee por delante de Kim?",
      prose: "En una carrera de 10 km, Kim terminó en 41:10, Lee en 39:55 y Mo en 42:30.",
    },
    fr: {
      question: "Lee a-t-il terminé devant Kim ?",
      prose: "Dans une course de 10 km, Kim a terminé en 41:10, Lee en 39:55 et Mo en 42:30.",
    },
    de: {
      question: "Ist Lee vor Kim ins Ziel gekommen?",
      prose: "Bei einem 10-km-Lauf kam Kim nach 41:10 ins Ziel, Lee nach 39:55 und Mo nach 42:30.",
    },
    zh: {
      question: "Lee 比 Kim 先到终点吗？",
      prose: "在一场 10 km 赛跑中，Kim 的成绩是 41:10，Lee 是 39:55，Mo 是 42:30。",
    },
    ja: {
      question: "Lee は Kim より先にゴールしましたか？",
      prose: "10 km のレースで、Kim のタイムは 41:10、Lee は 39:55、Mo は 42:30 でした。",
    },
    hi: {
      question: "क्या Lee ने Kim से पहले दौड़ पूरी की?",
      prose: "10 km की दौड़ में Kim ने 41:10 में, Lee ने 39:55 में और Mo ने 42:30 में दौड़ पूरी की।",
    },
    ar: {
      question: "هل أنهى Lee السباق قبل Kim؟",
      prose: "في سباق 10 km، أنهى Kim السباق في 41:10، وLee في 39:55، وMo في 42:30.",
    },
  },
  survey: {
    es: {
      question: "¿Dijo que sí la mayoría de los encuestados?",
      prose: "La encuesta tuvo 400 encuestados, y 180 de ellos dijeron que sí.",
    },
    fr: {
      question: "La majorité des répondants a-t-elle répondu oui ?",
      prose: "L'enquête a compté 400 répondants, dont 180 ont répondu oui.",
    },
    de: {
      question: "Hat die Mehrheit der Befragten mit Ja geantwortet?",
      prose: "An der Umfrage nahmen 400 Personen teil, 180 davon antworteten mit Ja.",
    },
    zh: {
      question: "大多数受访者回答“是”了吗？",
      prose: "这项调查共有 400 名受访者，其中 180 人回答“是”。",
    },
    ja: {
      question: "回答者の過半数が「はい」と答えましたか？",
      prose: "この調査の回答者は 400 人で、そのうち 180 人が「はい」と答えました。",
    },
    hi: {
      question: "क्या अधिकांश उत्तरदाताओं ने हाँ कहा?",
      prose: "सर्वेक्षण में 400 उत्तरदाता थे, और उनमें से 180 ने हाँ कहा।",
    },
    ar: {
      question: "هل أجابت أغلبية المشاركين بنعم؟",
      prose: "شارك في الاستطلاع 400 شخص، أجاب 180 منهم بنعم.",
    },
  },
  shelf: {
    es: {
      question: "¿Caben los libros en la estantería uno al lado del otro?",
      prose: "La estantería mide 2 m de largo. Puestos uno al lado del otro, los libros ocupan 150 cm en total.",
    },
    fr: {
      question: "Les livres tiennent-ils côte à côte sur l'étagère ?",
      prose: "L'étagère mesure 2 m de long. Côte à côte, les livres font 150 cm de large au total.",
    },
    de: {
      question: "Passen die Bücher nebeneinander auf das Regal?",
      prose: "Das Regal ist 2 m lang. Nebeneinander sind die Bücher insgesamt 150 cm breit.",
    },
    zh: {
      question: "这些书并排能放进书架吗？",
      prose: "书架长 2 m。这些书并排放在一起总宽度为 150 cm。",
    },
    ja: {
      question: "本は横に並べて棚に収まりますか？",
      prose: "棚の長さは 2 m です。本を横に並べると、幅は合計 150 cm です。",
    },
    hi: {
      question: "क्या किताबें एक के बगल में एक रखकर शेल्फ़ पर आ जाएँगी?",
      prose: "शेल्फ़ 2 m लंबा है। एक के बगल में एक रखने पर किताबों की कुल चौड़ाई 150 cm है।",
    },
    ar: {
      question: "هل يتسع الرف للكتب إذا وُضعت جنبًا إلى جنب؟",
      prose: "طول الرف 2 m. وعند وضع الكتب جنبًا إلى جنب يبلغ عرضها الإجمالي 150 cm.",
    },
  },
  password: {
    es: {
      question: "¿Cumple la contraseña propuesta la regla?",
      prose: "La regla de contraseñas es: al menos 12 caracteres, incluido un número. La contraseña propuesta es sunflower88.",
    },
    fr: {
      question: "Le mot de passe proposé respecte-t-il la règle ?",
      prose: "La règle des mots de passe est : au moins 12 caractères, dont un chiffre. Le mot de passe proposé est sunflower88.",
    },
    de: {
      question: "Erfüllt das vorgeschlagene Passwort die Regel?",
      prose: "Die Passwortregel lautet: mindestens 12 Zeichen, darunter eine Zahl. Das vorgeschlagene Passwort ist sunflower88.",
    },
    zh: {
      question: "建议的密码符合规则吗？",
      prose: "密码规则是：至少 12 个字符，并包含一个数字。建议的密码是 sunflower88。",
    },
    ja: {
      question: "提案されたパスワードは規則を満たしていますか？",
      prose: "パスワードの規則は「12 文字以上で、数字を含むこと」です。提案されたパスワードは sunflower88 です。",
    },
    hi: {
      question: "क्या प्रस्तावित पासवर्ड नियम पूरा करता है?",
      prose: "पासवर्ड का नियम है: कम से कम 12 अक्षर, जिनमें एक अंक हो। प्रस्तावित पासवर्ड sunflower88 है।",
    },
    ar: {
      question: "هل تستوفي كلمة المرور المقترحة القاعدة؟",
      prose: "قاعدة كلمة المرور: 12 حرفًا على الأقل، منها رقم واحد. كلمة المرور المقترحة هي sunflower88.",
    },
  },
  store: {
    es: {
      question: "¿Está abierta la tienda a la hora de la visita?",
      prose: "La tienda abre de lunes a sábado de 09:00 a 18:00 y cierra el domingo. La visita es el sábado a las 10:30.",
    },
    fr: {
      question: "Le magasin est-il ouvert à l'heure de la visite ?",
      prose: "Le magasin est ouvert du lundi au samedi de 09:00 à 18:00 et fermé le dimanche. La visite a lieu samedi à 10:30.",
    },
    de: {
      question: "Ist das Geschäft zur Zeit des Besuchs geöffnet?",
      prose: "Das Geschäft hat Montag bis Samstag von 09:00 bis 18:00 geöffnet und sonntags geschlossen. Der Besuch ist am Samstag um 10:30.",
    },
    zh: {
      question: "到访时这家店开门吗？",
      prose: "这家店星期一至星期六 09:00 到 18:00 营业，星期日休息。到访时间是星期六 10:30。",
    },
    ja: {
      question: "訪問する時間に店は開いていますか？",
      prose: "店の営業時間は月曜から土曜の 09:00 から 18:00 までで、日曜は休みです。訪問は土曜日の 10:30 です。",
    },
    hi: {
      question: "क्या आने के समय दुकान खुली होगी?",
      prose: "दुकान सोमवार से शनिवार 09:00 से 18:00 तक खुलती है और रविवार को बंद रहती है। आने का समय शनिवार 10:30 है।",
    },
    ar: {
      question: "هل يكون المتجر مفتوحًا وقت الزيارة؟",
      prose: "يفتح المتجر من الاثنين إلى السبت من 09:00 إلى 18:00 ويُغلق يوم الأحد. الزيارة يوم السبت الساعة 10:30.",
    },
  },
  stock: {
    es: {
      question: "¿Se puede completar el pedido con el stock actual?",
      prose: "Hay 14 unidades en stock y se han pedido 20 unidades. No se admiten pedidos pendientes.",
    },
    fr: {
      question: "La commande peut-elle être honorée avec le stock actuel ?",
      prose: "Il y a 14 unités en stock et 20 unités commandées. Les commandes en attente ne sont pas autorisées.",
    },
    de: {
      question: "Kann die Bestellung aus dem aktuellen Lagerbestand erfüllt werden?",
      prose: "Es sind 14 Stück auf Lager und 20 Stück bestellt. Nachlieferungen sind nicht erlaubt.",
    },
    zh: {
      question: "现有库存能满足这个订单吗？",
      prose: "库存有 14 件，订单要 20 件。不允许延期交货。",
    },
    ja: {
      question: "この注文は現在の在庫で対応できますか？",
      prose: "在庫は 14 個で、注文は 20 個です。取り寄せ（バックオーダー）は認められていません。",
    },
    hi: {
      question: "क्या मौजूदा स्टॉक से ऑर्डर पूरा किया जा सकता है?",
      prose: "स्टॉक में 14 यूनिट हैं और 20 यूनिट का ऑर्डर है। बैकऑर्डर की अनुमति नहीं है।",
    },
    ar: {
      question: "هل يمكن تلبية الطلب من المخزون الحالي؟",
      prose: "يوجد في المخزون 14 وحدة والكمية المطلوبة 20 وحدة. لا يُسمح بالطلبات المؤجلة.",
    },
  },
};
