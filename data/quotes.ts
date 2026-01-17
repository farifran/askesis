/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
*/

import { StoicVirtue, StoicLevel, StoicDiscipline, GovernanceSphere } from '../state';

// --- TYPE DEFINITIONS ---

export type CoercionType = 'Dogmatic' | 'Inspirational' | 'Reflective' | 'Directive';

export type StoicTag = 
    | 'action' | 'resilience' | 'control' | 'time' | 'gratitude' | 'discipline' 
    | 'temperance' | 'nature' | 'learning' | 'humility' | 'reality' | 'suffering' 
    | 'focus' | 'virtue' | 'death' | 'anxiety' | 'community' | 'perception' 
    | 'change' | 'wisdom' | 'perspective' | 'responsibility' | 'morning' | 'evening' 
    | 'reflection' | 'duty' | 'rest' | 'consistency' | 'presence' | 'fate' 
    | 'simplicity' | 'healing' | 'mindset' | 'life' | 'love' | 'laziness' 
    | 'preparation' | 'prudence' | 'peace' | 'courage' | 'confidence' | 'growth' 
    | 'character' | 'solitude' | 'justice' | 'silence' | 'optimism' | 'creativity' 
    | 'passion' | 'reason' | 'history' | 'wealth' | 'happiness' | 'leadership' 
    | 'truth' | 'freedom' | 'acceptance' | 'integrity' | 'minimalism' | 'purpose' 
    | 'legacy' | 'fear' | 'belief' | 'identity' | 'practice' | 'authenticity' 
    | 'example' | 'desire' | 'habit' | 'listening' | 'values' | 'criticism' 
    | 'urgency' | 'patience' | 'strength' | 'honor' | 'essentialism' | 'flow' 
    | 'health' | 'hope' | 'speech' | 'body' | 'mindfulness' | 'friendship' 
    | 'anger' | 'kindness' | 'chaos' | 'judgment'
    | 'poverty' | 'discomfort'
    | 'breath'
    | 'pain' | 'endurance' | 'cold' | 'potential'
    | 'clarity' | 'order' | 'harmony'
    | 'fortune' | 'conscience' | 'role'
    | 'will' | 'recovery'
    | 'emotion' | 'consequences'
    | 'cosmopolitanism'
    | 'trust' | 'loyalty' | 'heart'
    | 'impermanence' | 'flux' | 'loss'
    | 'attention'
    | 'forgiveness' | 'pleasure' | 'distraction';

export interface Quote {
    id: string;
    author: string;
    original_text: {
        pt: string;
        en: string;
        es: string;
    };
    source: string;
    metadata: {
        virtue: StoicVirtue;
        level: StoicLevel;
        discipline: StoicDiscipline;
        sphere: GovernanceSphere;
        tags: StoicTag[];
        coercion_type: CoercionType;
    };
    adaptations: {
        level_1: { pt: string; en: string; es: string };
        level_2: { pt: string; en: string; es: string };
        level_3: { pt: string; en: string; es: string };
    };
}

// --- CATEGORY 1: MIND & PERCEPTION (Wisdom) ---
// Foco: Ansiedade, Controle, Julgamento, Aprendizado.
const MIND_QUOTES: Quote[] = [
    {
        id: "quote_ma_001",
        author: "marcusAurelius",
        original_text: {
            pt: "A felicidade da sua vida depende da qualidade dos seus pensamentos.",
            en: "The happiness of your life depends upon the quality of your thoughts.",
            es: "La felicidad de tu vida depende de la calidad de tus pensamientos.",
        },
        source: "Meditações, V.16",
        metadata: {
            virtue: "Wisdom",
            level: 1,
            discipline: "Assent",
            sphere: "Mental",
            tags: ["happiness", "mindset", "control", "perception", "morning", "focus", "mindfulness"],
            coercion_type: "Dogmatic"
        },
        adaptations: {
            level_1: {
                pt: "Lembre-se: uma mente tranquila vem de pensamentos tranquilos. Cuide do que você pensa.",
                en: "Remember: a peaceful mind comes from peaceful thoughts. Watch what you think.",
                es: "Recuerda: una mente tranquila proviene de pensamientos tranquilos. Cuida lo que piensas."
            },
            level_2: {
                pt: "Sua felicidade é um reflexo direto de seus pensamentos. Escolha-os com sabedoria.",
                en: "Your happiness is a direct reflection of your thoughts. Choose them wisely.",
                es: "Tu felicidad es un reflejo directo de tus pensamientos. Elígelos sabiamente."
            },
            level_3: {
                pt: "Pensamentos de qualidade, vida feliz.",
                en: "Quality thoughts, happy life.",
                es: "Pensamientos de calidad, vida feliz."
            }
        }
    },
    {
        id: "quote_ep_001",
        author: "epictetus",
        original_text: {
            pt: "Não é o que acontece com você, mas como você reage a isso que importa.",
            en: "It's not what happens to you, but how you react to it that matters.",
            es: "No es lo que te sucede, sino cómo reaccionas a ello lo que importa.",
        },
        source: "Enchiridion, V",
        metadata: {
            virtue: "Wisdom",
            level: 1,
            discipline: "Assent",
            sphere: "Mental",
            tags: ["control", "resilience", "perception", "judgment", "anger", "acceptance"],
            coercion_type: "Dogmatic"
        },
        adaptations: {
            level_1: {
                pt: "Eventos externos são neutros. É a sua reação que lhes dá poder. Escolha responder com calma e razão.",
                en: "External events are neutral. It is your reaction that gives them power. Choose to respond with calm and reason.",
                es: "Los eventos externos son neutrales. Es tu reacción la que les da poder. Elige responder con calma y razón."
            },
            level_2: {
                pt: "Você não controla os eventos, mas controla sua resposta a eles. Aí reside sua força.",
                en: "You don't control events, but you control your response to them. Therein lies your strength.",
                es: "No controlas los eventos, pero controlas tu respuesta a ellos. Ahí reside tu fuerza."
            },
            level_3: {
                pt: "A reação, não o evento.",
                en: "The reaction, not the event.",
                es: "La reacción, no el evento."
            }
        }
    },
    {
        id: "quote_se_001",
        author: "seneca",
        original_text: {
            pt: "Sofremos mais na imaginação do que na realidade.",
            en: "We suffer more often in imagination than in reality.",
            es: "Sufrimos más a menudo en la imaginación que en la realidad.",
        },
        source: "Cartas a Lucílio, XIII",
        metadata: {
            virtue: "Temperance",
            level: 2,
            discipline: "Desire",
            sphere: "Mental",
            tags: ["anxiety", "fear", "perception", "mindset", "evening", "rest", "acceptance"],
            coercion_type: "Reflective"
        },
        adaptations: {
            level_1: {
                pt: "Muitos dos seus medos nunca se concretizarão. Concentre-se no presente em vez de se preocupar com futuros imaginários.",
                en: "Many of your fears will never come to pass. Focus on the present rather than worrying about imagined futures.",
                es: "Muchos de tus miedos nunca se harán realidad. Concéntrate en el presente en lugar de preocuparte por futuros imaginarios."
            },
            level_2: {
                pt: "Separe o que é real do que é apenas ansiedade. A maior parte do seu sofrimento é autoinfligida.",
                en: "Separate what is real from what is merely anxiety. Most of your suffering is self-inflicted.",
                es: "Separa lo que es real de lo que es simplemente ansiedad. La mayor parte de tu sufrimiento es autoinfligido."
            },
            level_3: {
                pt: "Imaginação fere mais que a realidade.",
                en: "Imagination hurts more than reality.",
                es: "La imaginación duele más que la realidad."
            }
        }
    },
    {
        id: "cit_epicteto_controle_01",
        author: "epictetus",
        original_text: {
            pt: "Algumas coisas estão sob nosso controle e outras não. Sob nosso controle estão opinião, busca, desejo, aversão e, numa palavra, tudo o que é nossa própria ação.",
            en: "Some things are in our control and others not. Things in our control are opinion, pursuit, desire, aversion, and, in a word, whatever are our own actions.",
            es: "Algunas cosas están bajo nuestro control y otras no. Bajo nuestro control están la opinión, la búsqueda, el deseo, la aversión y, en una palabra, cualquier cosa que sea nuestra propia acción.",
        },
        source: "Enchiridion, I",
        metadata: {
            virtue: "Wisdom",
            level: 1,
            discipline: "Assent",
            sphere: "Mental",
            tags: ["control", "perception", "wisdom", "freedom", "morning", "acceptance", "action"],
            coercion_type: "Dogmatic"
        },
        adaptations: {
            level_1: {
                pt: "Eu não me perturbo com o que está fora do meu controle; foco apenas no meu julgamento.",
                en: "I am not disturbed by what is out of my control; I focus only on my judgment.",
                es: "No me perturbo por lo que está fuera de mi control; me enfoco solo en mi juicio."
            },
            level_2: {
                pt: "A liberdade começa com a distinção entre o que depende de nós e o que não depende. Ignore o resto.",
                en: "Freedom begins with the distinction between what depends on us and what does not. Ignore the rest.",
                es: "La libertad comienza con la distinción entre lo que depende de nosotros y lo que no. Ignora el resto."
            },
            level_3: {
                pt: "Distingua e renuncie.",
                en: "Distinguish and renounce.",
                es: "Distingue y renuncia."
            }
        }
    },
    {
        id: "cit_seneca_antecipacao_01",
        author: "seneca",
        original_text: {
            pt: "Aquele que antecipou a chegada dos problemas tira-lhes o poder quando eles chegam.",
            en: "The man who has anticipated the coming of troubles takes away their power when they arrive.",
            es: "El que ha anticipado la llegada de los problemas les quita el poder cuando llegan.",
        },
        source: "Consolação a Márcia, IX",
        metadata: {
            virtue: "Courage",
            level: 1,
            discipline: "Desire",
            sphere: "Mental",
            tags: ["preparation", "resilience", "anxiety", "fate", "morning", "humility"],
            coercion_type: "Directive"
        },
        adaptations: {
            level_1: {
                pt: "Nada do que acontece me surpreende, pois a minha mente já antecipou o combate.",
                en: "Nothing that happens surprises me, for my mind has already anticipated the combat.",
                es: "Nada de lo que sucede me sorprende, pues mi mente ya ha anticipado el combate."
            },
            level_2: {
                pt: "Visualize os desafios antes que aconteçam. O golpe previsto é menos doloroso.",
                en: "Visualize challenges before they happen. The foreseen blow is less painful.",
                es: "Visualiza los desafíos antes de que sucedan. El golpe previsto es menos doloroso."
            },
            level_3: {
                pt: "Premeditatio Malorum.",
                en: "Premeditatio Malorum.",
                es: "Premeditatio Malorum."
            }
        }
    },
    {
        id: "cit_seneca_leitura_01",
        author: "seneca",
        original_text: {
            pt: "Você deve permanecer entre um número limitado de grandes pensadores e digerir suas obras se quiser derivar ideias que se firmem em sua mente.",
            en: "You must linger among a limited number of master-thinkers, and digest their works, if you would derive ideas which shall win firm hold in your mind.",
            es: "Debes permanecer entre un número limitado de grandes pensadores y digerir sus obras si quieres derivar ideas que se afirmen en tu mente.",
        },
        source: "Cartas a Lucílio, II",
        metadata: {
            virtue: "Wisdom",
            level: 2,
            discipline: "Assent",
            sphere: "Mental",
            tags: ["learning", "focus", "wisdom", "mindset", "discipline"],
            coercion_type: "Directive"
        },
        adaptations: {
            level_1: {
                pt: "Leio não para acumular fatos, mas para transformar meu caráter através do diálogo com os sábios.",
                en: "I read not to accumulate facts, but to transform my character through dialogue with the wise.",
                es: "Leo no para acumular hechos, sino para transformar mi carácter a través del diálogo con los sabios."
            },
            level_2: {
                pt: "Evite a leitura dispersa. Aprofunde-se nos mestres que nutrem a alma e fortalecem a razão.",
                en: "Avoid scattered reading. Go deep into the masters who nourish the soul and strengthen reason.",
                es: "Evita la lectura dispersa. Profundiza en los maestros que nutren el alma y fortalecen la razón."
            },
            level_3: {
                pt: "Lectio: Leitura profunda.",
                en: "Lectio: Deep reading.",
                es: "Lectio: Lectura profunda."
            }
        }
    },
    {
        id: "cit_marco_escrita_01",
        author: "marcusAurelius",
        original_text: {
            pt: "Nada tem tanto poder para expandir a mente como a capacidade de investigar sistematicamente e verdadeiramente tudo o que vem sob sua observação na vida.",
            en: "Nothing has such power to broaden the mind as the ability to investigate systematically and truly all that comes under thy observation in life.",
            es: "Nada tiene tanto poder para expandir la mente como la capacidad de investigar sistemática y verdaderamente todo lo que viene bajo tu observación en la vida.",
        },
        source: "Meditações, III.11",
        metadata: {
            virtue: "Wisdom",
            level: 1,
            discipline: "Assent",
            sphere: "Mental",
            tags: ["reflection", "growth", "wisdom", "clarity", "evening", "focus"],
            coercion_type: "Inspirational"
        },
        adaptations: {
            level_1: {
                pt: "Escrevo para dialogar comigo mesmo, organizar o caos mental e manter a vigilância sobre meus atos.",
                en: "I write to dialogue with myself, organize mental chaos, and maintain vigilance over my actions.",
                es: "Escribo para dialogar conmigo mismo, organizar el caos mental y mantener la vigilancia sobre mis actos."
            },
            level_2: {
                pt: "O diário é a ferramenta do filósofo. Ao registrar seus pensamentos, você os examina e os purifica.",
                en: "The journal is the philosopher's tool. By recording your thoughts, you examine and purify them.",
                es: "El diario es la herramienta del filósofo. Al registrar tus pensamientos, los examinas y los purificas."
            },
            level_3: {
                pt: "Hypomnemata: Notas para si.",
                en: "Hypomnemata: Notes to oneself.",
                es: "Hypomnemata: Notas para uno mismo."
            }
        }
    },
    {
        id: "cit_socrates_aprendizado_01",
        author: "socrates",
        original_text: {
            pt: "Só sei que nada sei.",
            en: "I know only that I know nothing.",
            es: "Solo sé que no sé nada.",
        },
        source: "Platão, Apologia",
        metadata: {
            virtue: "Wisdom",
            level: 1,
            discipline: "Assent",
            sphere: "Mental",
            tags: ["learning", "humility", "wisdom", "growth"],
            coercion_type: "Reflective"
        },
        adaptations: {
            level_1: {
                pt: "Busco aprender algo novo hoje, reconhecendo minha ignorância como o primeiro passo para a sabedoria.",
                en: "I seek to learn something new today, recognizing my ignorance as the first step to wisdom.",
                es: "Busco aprender algo nuevo hoy, reconociendo mi ignorancia como el primer paso hacia la sabiduría."
            },
            level_2: {
                pt: "A mente que se fecha para aprender, morre. Mantenha a curiosidade viva e a humildade intelectual.",
                en: "The mind that closes to learning dies. Keep curiosity alive and intellectual humility.",
                es: "La mente que se cierra al aprendizaje muere. Mantén viva la curiosidad y la humildad intelectual."
            },
            level_3: {
                pt: "Episteme: Conhecimento Real.",
                en: "Episteme: True Knowledge.",
                es: "Episteme: Conocimiento Verdadero."
            }
        }
    },
    {
        id: "cit_seneca_reflexao_01",
        author: "seneca",
        original_text: {
            pt: "Quando a luz for retirada... examinarei todo o meu dia e revisarei meus atos e palavras. Nada esconderei de mim mesmo.",
            en: "When the light has been removed... I examine my entire day and go back over what I've done and said, hiding nothing from myself.",
            es: "Cuando se haya retirado la luz... examinaré todo mi día y repasaré mis hechos y dichos. Nada me ocultaré a mí mismo."
        },
        source: "Sobre a Ira, III.36",
        metadata: {
            virtue: "Wisdom",
            level: 1,
            discipline: "Assent",
            sphere: "Mental",
            tags: ["evening", "reflection", "conscience", "growth", "integrity"],
            coercion_type: "Directive"
        },
        adaptations: {
            level_1: {
                pt: "Antes de dormir, revise seu dia. Onde você acertou? Onde errou? Como pode melhorar amanhã?",
                en: "Before sleeping, review your day. Where did you succeed? Where did you fail? How can you improve tomorrow?",
                es: "Antes de dormir, revisa tu día. ¿Dónde acertaste? ¿Dónde fallaste? ¿Cómo puedes mejorar mañana?"
            },
            level_2: {
                pt: "O tribunal da consciência deve ser visitado todas as noites. Seja seu próprio juiz, mas também seu próprio guia.",
                en: "The court of conscience must be visited every night. Be your own judge, but also your own guide.",
                es: "El tribunal de la conciencia debe ser visitado cada noche. Sé tu propio juez, pero también tu propio guía."
            },
            level_3: {
                pt: "Examine seu dia.",
                en: "Examine your day.",
                es: "Examina tu día."
            }
        }
    },
    {
        id: "cit_epicteto_atencao_01",
        author: "epictetus",
        original_text: {
            pt: "Quando você relaxa sua atenção por um tempo, não pense que a recuperará sempre que desejar.",
            en: "When you let your attention slide for a bit, do not think you will get back a grip on it whenever you wish.",
            es: "Cuando relajas tu atención por un tiempo, no pienses que la recuperarás cuando desees."
        },
        source: "Discursos, IV.12",
        metadata: {
            virtue: "Temperance",
            level: 2,
            discipline: "Assent",
            sphere: "Mental",
            tags: ["focus", "mindfulness", "discipline", "attention", "habit"],
            coercion_type: "Directive"
        },
        adaptations: {
            level_1: {
                pt: "Se você se permitir ser descuidado hoje, será mais difícil ser disciplinado amanhã.",
                en: "If you allow yourself to be careless today, it will be harder to be disciplined tomorrow.",
                es: "Si te permites ser descuidado hoy, será más difícil ser disciplinado mañana."
            },
            level_2: {
                pt: "A 'Prosoche' (atenção plena) deve ser constante. Uma exceção abre a porta para o vício.",
                en: "'Prosoche' (mindfulness) must be constant. An exception opens the door to vice.",
                es: "La 'Prosoche' (atención plena) debe ser constante. Una excepción abre la puerta al vicio."
            },
            level_3: {
                pt: "Atenção constante.",
                en: "Constant attention.",
                es: "Atención constante."
            }
        }
    },
    {
        id: "cit_epicteto_tolo_01",
        author: "epictetus",
        original_text: {
            pt: "Se você quer progredir, contente-se em parecer tolo e estúpido nas coisas externas.",
            en: "If you want to improve, be content to be thought foolish and stupid.",
            es: "Si quieres progresar, conténtate con parecer tonto y estúpido en las cosas externas."
        },
        source: "Enchiridion, 13",
        metadata: {
            virtue: "Wisdom",
            level: 3,
            discipline: "Assent",
            sphere: "Mental",
            tags: ["humility", "learning", "growth", "judgment", "freedom"],
            coercion_type: "Dogmatic"
        },
        adaptations: {
            level_1: {
                pt: "Não tenha vergonha de não saber. A vontade de aprender é mais valiosa que a aparência de inteligência.",
                en: "Don't be ashamed of not knowing. The will to learn is more valuable than the appearance of intelligence.",
                es: "No te avergüences de no saber. La voluntad de aprender es más valiosa que la apariencia de inteligencia."
            },
            level_2: {
                pt: "Abandone o ego intelectual. Para preencher a mente com a verdade, primeiro esvazie-a da presunção.",
                en: "Abandon intellectual ego. To fill the mind with truth, first empty it of conceit.",
                es: "Abandona el ego intelectual. Para llenar la mente con la verdad, primero vacíala de presunción."
            },
            level_3: {
                pt: "Pareça tolo para ser sábio.",
                en: "Seem foolish to be wise.",
                es: "Parece tonto para ser sabio."
            }
        }
    }
];

// --- CATEGORY 2: ACTION & DISCIPLINE (The Engine) ---
// Foco: Preguiça, Consistência, Prática, Tempo.
const ACTION_QUOTES: Quote[] = [
    {
        id: "cit_seneca_tempo_01",
        author: "seneca",
        original_text: {
            pt: "Não é que tenhamos pouco tempo, mas desperdiçamos muito.",
            en: "It is not that we have a short time to live, but that we waste a lot of it.",
            es: "No es que tengamos poco tiempo, sino que perdemos mucho.",
        },
        source: "Sobre a Brevidade da Vida",
        metadata: {
            virtue: "Wisdom",
            level: 1,
            discipline: "Action",
            sphere: "Structural",
            tags: ["time", "focus", "urgency", "life", "morning", "action"],
            coercion_type: "Directive"
        },
        adaptations: {
            level_1: {
                pt: "Planejo meu dia para não ser escravo do acaso. O tempo é meu recurso mais precioso e irrecuperável.",
                en: "I plan my day so as not to be a slave to chance. Time is my most precious and irrecoverable resource.",
                es: "Planeo mi día para no ser esclavo del azar. El tiempo es mi recurso más precioso e irrecuperable."
            },
            level_2: {
                pt: "Organizar o tempo é organizar a vida. Não deixe que os minutos escorram por descuido.",
                en: "To organize time is to organize life. Do not let minutes slip away through carelessness.",
                es: "Organizar el tiempo es organizar la vida. No dejes que los minutos se escapen por descuido."
            },
            level_3: {
                pt: "Taxis: Arranjo.",
                en: "Taxis: Arrangement.",
                es: "Taxis: Arreglo."
            }
        }
    },
    {
        id: "cit_marco_trabalho_01",
        author: "marcusAurelius",
        original_text: {
            pt: "Ao amanhecer, quando tiver dificuldade em sair da cama, diga a si mesmo: 'Tenho que ir trabalhar — como ser humano.'",
            en: "At dawn, when you have trouble getting out of bed, tell yourself: 'I have to go to work — as a human being.'",
            es: "Al amanecer, cuando te cueste salir de la cama, dite a ti mismo: 'Tengo que ir a trabajar — como ser humano.'"
        },
        source: "Meditações, V.1",
        metadata: {
            virtue: "Justice",
            level: 1,
            discipline: "Action",
            sphere: "Social",
            tags: ["action", "discipline", "consistency", "morning", "duty"],
            coercion_type: "Directive"
        },
        adaptations: {
            level_1: {
                pt: "Está difícil começar? Lembre-se que você foi feito para agir, não para ficar deitado. Levante e faça o que precisa ser feito.",
                en: "Hard to start? Remember you were made to act, not to lie down. Get up and do what needs to be done.",
                es: "¿Difícil empezar? Recuerda que fuiste hecho para actuar, no para estar tumbado. Levántate y haz lo que debes."
            },
            level_2: {
                pt: "A 'Oikeiosis' humana é a atividade racional e social. Ficar na inércia é negar sua própria natureza e função.",
                en: "Human 'Oikeiosis' is rational and social activity. Staying in inertia is denying your own nature and function.",
                es: "La 'Oikeiosis' humana es la actividad racional y social. Quedarse en la inercia es negar tu propia naturaleza y función."
            },
            level_3: {
                pt: "Levante para sua natureza.",
                en: "Rise to your nature.",
                es: "Levántate a tu naturaleza."
            }
        }
    },
    {
        id: "cit_seneca_adiar_01",
        author: "seneca",
        original_text: {
            pt: "Enquanto desperdiçamos nosso tempo hesitando e adiando, a vida está passando.",
            en: "While we are postponing, life speeds by.",
            es: "Mientras posponemos, la vida pasa corriendo."
        },
        source: "Cartas a Lucílio, I",
        metadata: {
            virtue: "Wisdom",
            level: 1,
            discipline: "Action",
            sphere: "Structural",
            tags: ["action", "discipline", "consistency", "urgency", "time"],
            coercion_type: "Inspirational"
        },
        adaptations: {
            level_1: {
                pt: "Pare de pensar e comece a fazer. A procrastinação está roubando o único tempo que você tem: o agora.",
                en: "Stop thinking and start doing. Procrastination is stealing the only time you have: the now.",
                es: "Deja de pensar y empieza a hacer. La procrastinación te roba el único tiempo que tienes: el ahora."
            },
            level_2: {
                pt: "O vício da inércia é curado pela ação imediata. Não projete a virtude no futuro; execute-a no presente.",
                en: "The vice of inertia is cured by immediate action. Do not project virtue into the future; execute it in the present.",
                es: "El vicio de la inercia se cura con la acción inmediata. No proyectes la virtud en el futuro; ejecútala en el presente."
            },
            level_3: {
                pt: "Hesitar é perder vida.",
                en: "To hesitate is to lose life.",
                es: "Dudar es perder vida."
            }
        }
    },
    {
        id: "cit_epicteto_pratica_01",
        author: "epictetus",
        original_text: {
            pt: "Pratique, pelos deuses, nas pequenas coisas, e depois prossiga para as maiores.",
            en: "Practice yourself, for heaven's sake in little things, and then proceed to greater.",
            es: "Practícate, por los dioses, en las cosas pequeñas, y luego procede a las mayores."
        },
        source: "Discursos, I.18",
        metadata: {
            virtue: "Temperance",
            level: 2,
            discipline: "Action",
            sphere: "Structural",
            tags: ["action", "discipline", "consistency", "growth", "habit"],
            coercion_type: "Dogmatic"
        },
        adaptations: {
            level_1: {
                pt: "Não tente ser herói no primeiro dia. Comece com uma tarefa pequena agora mesmo e mantenha a constância.",
                en: "Don't try to be a hero on day one. Start with a small task right now and keep consistency.",
                es: "No intentes ser un héroe el primer día. Empieza con una tarea pequeña ahora mismo y mantén la constancia."
            },
            level_2: {
                pt: "A 'Askesis' começa no trivial. A consistência em atos menores fortalece a Vontade para os maiores desafios.",
                en: "'Askesis' begins in the trivial. Consistency in minor acts strengthens the Will for greater challenges.",
                es: "La 'Askesis' comienza en lo trivial. La constancia en actos menores fortalece la Voluntad para mayores desafíos."
            },
            level_3: {
                pt: "Pequeno hoje, grande amanhã.",
                en: "Small today, big tomorrow.",
                es: "Pequeño hoy, grande mañana."
            }
        }
    },
    {
        id: "cit_musonio_teoria_01",
        author: "musoniusRufus",
        original_text: {
            pt: "A teoria que ensina como se deve agir está para a ação como o conhecimento musical está para a execução.",
            en: "Theory which teaches how one should act is related to action as the musician's knowledge of music is related to his performance.",
            es: "La teoría que enseña cómo se debe actuar está para la acción como el conocimiento musical está para la ejecución."
        },
        source: "Fragmentos",
        metadata: {
            virtue: "Wisdom",
            level: 2,
            discipline: "Action",
            sphere: "Mental",
            tags: ["action", "discipline", "consistency", "learning", "practice"],
            coercion_type: "Reflective"
        },
        adaptations: {
            level_1: {
                pt: "Saber o que fazer não adianta nada se você não fizer. O conhecimento só tem valor quando aplicado.",
                en: "Knowing what to do is useless if you don't do it. Knowledge only has value when applied.",
                es: "Saber qué hacer no sirve de nada si no lo haces. El conocimiento solo tiene valor cuando se aplica."
            },
            level_2: {
                pt: "Logos sem Ergon é estéril. A sabedoria não é acumulada na mente, mas demonstrada nos hábitos.",
                en: "Logos without Ergon is sterile. Wisdom is not accumulated in the mind, but demonstrated in habits.",
                es: "Logos sin Ergon es estéril. La sabiduría no se acumula en la mente, sino que se demuestra en los hábitos."
            },
            level_3: {
                pt: "Saber é fazer.",
                en: "Knowing is doing.",
                es: "Saber es hacer."
            }
        }
    },
    {
        id: "quote_ze_001",
        author: "zeno",
        original_text: {
            pt: "O bem-estar é alcançado através de pequenos passos, mas não é uma coisa pequena.",
            en: "Well-being is realized by small steps, but is truly no small thing.",
            es: "El bienestar se logra con pequeños pasos, pero no es algo pequeño.",
        },
        source: "Diogenes Laertius, Vidas dos Filósofos",
        metadata: {
            virtue: "Justice",
            level: 1,
            discipline: "Action",
            sphere: "Structural",
            tags: ["action", "discipline", "consistency", "habit", "growth", "morning", "hope"],
            coercion_type: "Inspirational"
        },
        adaptations: {
            level_1: {
                pt: "Grandes mudanças são construídas com pequenas ações diárias. Concentre-se no próximo passo, não na montanha inteira.",
                en: "Great changes are built with small, daily actions. Focus on the next step, not the whole mountain.",
                es: "Los grandes cambios se construyen con pequeñas acciones diarias. Concéntrate en el siguiente paso, no en toda la montaña."
            },
            level_2: {
                pt: "A excelência não é um ato, mas um hábito. Cada pequeno passo que você dá hoje constrói seu bem-estar amanhã.",
                en: "Excellence is not an act, but a habit. Every small step you take today builds your well-being tomorrow.",
                es: "La excelencia no es un acto, sino un hábito. Cada pequeño paso que das hoy construye tu bienestar de mañana."
            },
            level_3: {
                pt: "Pequenos passos, grande bem-estar.",
                en: "Small steps, great well-being.",
                es: "Pequeños pasos, gran bienestar."
            }
        }
    },
    {
        id: "cit_seneca_inibicao_01",
        author: "seneca",
        original_text: {
            pt: "Devemos tratar o corpo com algum rigor, para que não seja desobediente à mente.",
            en: "We must treat the body with some rigour, so that it may not be disobedient to the mind.",
            es: "Debemos tratar el cuerpo con cierto rigor, para que no sea desobediente a la mente.",
        },
        source: "Cartas a Lucílio, VIII",
        metadata: {
            virtue: "Courage",
            level: 1,
            discipline: "Desire",
            sphere: "Biological",
            tags: ["body", "pain", "endurance", "cold", "discomfort", "discipline", "action"],
            coercion_type: "Directive"
        },
        adaptations: {
            level_1: {
                pt: "Eu voluntariamente aceito o desconforto para que ele nunca me escravize.",
                en: "I voluntarily accept discomfort so that it never enslaves me.",
                es: "Acepto voluntariamente la incomodidad para que nunca me esclavice."
            },
            level_2: {
                pt: "Ao suportar o frio e a fome, lembro ao meu corpo quem comanda. O rigor físico fortalece a vontade.",
                en: "By enduring cold and hunger, I remind my body who is in charge. Physical rigour strengthens the will.",
                es: "Al soportar el frío y el hambre, recuerdo a mi cuerpo quién manda. El rigor físico fortalece la voluntad."
            },
            level_3: {
                pt: "Suportar e abster-se.",
                en: "Endure and renounce.",
                es: "Soportar y renunciar."
            }
        }
    },
    {
        id: "cit_socrates_movimento_01",
        author: "socrates",
        original_text: {
            pt: "É uma desgraça envelhecer por puro descuido antes de ver que tipo de homem você pode se tornar desenvolvendo sua força corporal e beleza ao seu limite máximo.",
            en: "It is a disgrace to grow old through sheer carelessness before seeing what manner of man you may become by developing your bodily strength and beauty to their highest limit.",
            es: "Es una desgracia envejecer por puro descuido antes de ver qué tipo de hombre puedes llegar a ser desarrollando tu fuerza corporal y belleza hasta su límite máximo.",
        },
        source: "Xenophon, Memorabilia",
        metadata: {
            virtue: "Courage",
            level: 1,
            discipline: "Action",
            sphere: "Structural",
            tags: ["strength", "body", "action", "potential", "discipline", "urgency"],
            coercion_type: "Inspirational"
        },
        adaptations: {
            level_1: {
                pt: "Mantenho o corpo forte para que ele obedeça à minha razão e seja útil ao mundo.",
                en: "I keep my body strong so that it obeys my reason and is useful to the world.",
                es: "Mantengo el cuerpo fuerte para que obedezca a mi razón y sea útil al mundo."
            },
            level_2: {
                pt: "Um corpo fraco comanda a mente; um corpo forte obedece. Treine para a funcionalidade, não para a vaidade.",
                en: "A weak body commands the mind; a strong body obeys. Train for functionality, not vanity.",
                es: "Un cuerpo débil manda a la mente; un cuerpo fuerte obedece. Entrena para la funcionalidad, no para la vanidad."
            },
            level_3: {
                pt: "Corpo forte, mente livre.",
                en: "Strong body, free mind.",
                es: "Cuerpo fuerte, mente libre."
            }
        }
    },
    {
        id: "cit_marco_ordem_01",
        author: "marcusAurelius",
        original_text: {
            pt: "Que nenhum ato seja feito sem propósito, nem de outra forma que não de acordo com um princípio perfeito da arte.",
            en: "Let no act be done without a purpose, nor otherwise than according to the perfect principles of art.",
            es: "Que ningún acto se haga sin propósito, ni de otra manera que no sea de acuerdo con un principio perfecto del arte.",
        },
        source: "Meditações, IV.2",
        metadata: {
            virtue: "Temperance",
            level: 1,
            discipline: "Action",
            sphere: "Structural",
            tags: ["discipline", "order", "focus", "simplicity", "evening", "action"],
            coercion_type: "Directive"
        },
        adaptations: {
            level_1: {
                pt: "Organizo meu ambiente para refletir a ordem que desejo em minha mente. O externo influencia o interno.",
                en: "I organize my environment to reflect the order I desire in my mind. The external influences the internal.",
                es: "Organizo mi entorno para reflejar el orden que deseo en mi mente. Lo externo influye en lo interno."
            },
            level_2: {
                pt: "A desordem externa é um ruído para a razão. Elimine o supérfluo e organize o essencial.",
                en: "External disorder is noise to reason. Eliminate the superfluous and organize the essential.",
                es: "El desorden externo es ruido para la razón. Elimina lo superfluo y organiza lo esencial."
            },
            level_3: {
                pt: "Kosmos: Ordem e Beleza.",
                en: "Kosmos: Order and Beauty.",
                es: "Kosmos: Orden y Belleza."
            }
        }
    },
    {
        id: "cit_marco_compostura_01",
        author: "marcusAurelius",
        original_text: {
            pt: "É preciso compor o corpo inteiro, para que não haja nele nada de desordenado ou afetado; pois o mesmo caráter que a mente manifesta no rosto deve ser exigido do corpo inteiro.",
            en: "To have the face also obedient to the mind and allowing the mind to regulate its expression and its composition... this must be required of the whole body.",
            es: "Es necesario componer todo el cuerpo, para que no haya en él nada desordenado o afectado; pues el mismo carácter que la mente manifiesta en el rostro debe exigirse de todo el cuerpo.",
        },
        source: "Meditações, VII.60",
        metadata: {
            virtue: "Justice",
            level: 1,
            discipline: "Action",
            sphere: "Biological",
            tags: ["body", "character", "mindfulness", "action", "discipline"],
            coercion_type: "Directive"
        },
        adaptations: {
            level_1: {
                pt: "Sua postura reflete sua mente. Mantenha-se ereto e sereno, mostrando ao mundo a ordem que existe dentro de você.",
                en: "Your posture reflects your mind. Stand tall and serene, showing the world the order that exists within you.",
                es: "Tu postura refleja tu mente. Mantente erguido y sereno, mostrando al mundo el orden que existe dentro de ti."
            },
            level_2: {
                pt: "Não deixe que seu corpo traia sua filosofia. A dignidade física é uma extensão da dignidade moral.",
                en: "Do not let your body betray your philosophy. Physical dignity is an extension of moral dignity.",
                es: "No dejes que tu cuerpo traicione tu filosofia. La dignidad física es una extensión de la dignidad moral."
            },
            level_3: {
                pt: "Corpo ordenado, mente ordenada.",
                en: "Ordered body, ordered mind.",
                es: "Cuerpo ordenado, mente ordenada."
            }
        }
    },
    {
        id: "cit_marco_urgencia_01",
        author: "marcusAurelius",
        original_text: {
            pt: "Você pode deixar a vida agora. Que isso determine o que você faz, diz e pensa.",
            en: "You could leave life right now. Let that determine what you do and say and think.",
            es: "Podrías dejar la vida ahora mismo. Que eso determine lo que haces, dices y piensas."
        },
        source: "Meditações, II.11",
        metadata: {
            virtue: "Courage",
            level: 1,
            discipline: "Action",
            sphere: "Structural",
            tags: ["death", "urgency", "action", "focus", "time", "truth"],
            coercion_type: "Dogmatic"
        },
        adaptations: {
            level_1: {
                pt: "Não desperdice o tempo com o que não importa. Se hoje fosse seu último dia, você faria o que está fazendo?",
                en: "Don't waste time on what doesn't matter. If today were your last day, would you do what you are doing?",
                es: "No pierdas el tiempo en lo que no importa. Si hoy fuera tu último día, ¿harías lo que estás haciendo?"
            },
            level_2: {
                pt: "Memento Mori: A consciência da morte não deve causar medo, mas clareza e ação imediata.",
                en: "Memento Mori: The awareness of death should not cause fear, but clarity and immediate action.",
                es: "Memento Mori: La conciencia de la muerte no debe causar miedo, sino claridad y acción inmediata."
            },
            level_3: {
                pt: "Você pode partir agora.",
                en: "You could leave now.",
                es: "Podrías irte ahora."
            }
        }
    },
    {
        id: "cit_seneca_lugarnenhum_01",
        author: "seneca",
        original_text: {
            pt: "Estar em todo lugar é estar em lugar nenhum.",
            en: "To be everywhere is to be nowhere.",
            es: "Estar en todas partes es no estar en ninguna."
        },
        source: "Cartas a Lucílio, II",
        metadata: {
            virtue: "Wisdom",
            level: 1,
            discipline: "Action",
            sphere: "Mental",
            tags: ["focus", "distraction", "presence", "attention", "action"],
            coercion_type: "Directive"
        },
        adaptations: {
            level_1: {
                pt: "Concentre-se no que está fazendo agora. Tentar fazer tudo ao mesmo tempo é o mesmo que não fazer nada bem.",
                en: "Focus on what you are doing now. Trying to do everything at once is the same as doing nothing well.",
                es: "Concéntrate en lo que estás haciendo ahora. Intentar hacer todo a la vez es lo mismo que no hacer nada bien."
            },
            level_2: {
                pt: "A dispersão enfraquece a mente. Limite seus objetivos e aprofunde sua atenção em um ponto de cada vez.",
                en: "Dispersion weakens the mind. Limit your goals and deepen your attention on one point at a time.",
                es: "La dispersión debilita la mente. Limita tus objetivos y profundiza tu atención en un punto a la vez."
            },
            level_3: {
                pt: "Um foco, uma ação.",
                en: "One focus, one action.",
                es: "Un foco, una acción."
            }
        }
    }
];

// --- CATEGORY 3: RESILIENCE & RECOVERY (The Shield) ---
// Foco: Dor, Falha, Destino, Sofrimento.
const RESILIENCE_QUOTES: Quote[] = [
    {
        id: "quote_ma_002",
        author: "marcusAurelius",
        original_text: {
            pt: "O obstáculo à ação avança a ação. O que fica no caminho se torna o caminho.",
            en: "The impediment to action advances action. What stands in the way becomes the way.",
            es: "El impedimento a la acción avanza la acción. Lo que se interpone en el camino se convierte en el camino.",
        },
        source: "Meditações, V.20",
        metadata: {
            virtue: "Courage",
            level: 3,
            discipline: "Action",
            sphere: "Structural",
            tags: ["resilience", "action", "suffering", "perspective", "chaos", "strength", "acceptance"],
            coercion_type: "Reflective"
        },
        adaptations: {
            level_1: {
                pt: "Veja cada problema não como uma barreira, mas como uma oportunidade para praticar a virtude e crescer.",
                en: "See every problem not as a barrier, but as an opportunity to practice virtue and grow.",
                es: "Ve cada problema no como una barrera, sino como una oportunidad para practicar la virtud y crecer."
            },
            level_2: {
                pt: "Transforme seus obstáculos em degraus. O desafio à sua frente é o seu verdadeiro caminho.",
                en: "Turn your obstacles into stepping stones. The challenge in front of you is your true path.",
                es: "Convierte tus obstáculos en peldaños. El desafío que tienes delante es tu verdadero camino."
            },
            level_3: {
                pt: "O obstáculo é o caminho.",
                en: "The obstacle is the way.",
                es: "El obstáculo es el camino."
            }
        }
    },
    {
        id: "cit_seneca_resiliencia_02",
        author: "seneca",
        original_text: {
            pt: "O fogo prova o ouro; a miséria, os homens fortes.",
            en: "Fire tests gold, suffering tests brave men.",
            es: "El fuego prueba el oro; la miseria, a los hombres fuertes."
        },
        source: "De Providentia, 5.9",
        metadata: {
            virtue: "Courage",
            level: 3,
            discipline: "Action",
            sphere: "Structural",
            tags: ["resilience", "suffering", "strength", "fate", "healing"],
            coercion_type: "Inspirational"
        },
        adaptations: {
            level_1: {
                pt: "Está difícil? Ótimo. É neste momento que você descobre sua verdadeira força. Não desista.",
                en: "Is it hard? Good. This is the moment you discover your true strength. Don't give up.",
                es: "¿Es difícil? Bien. Es en este momento que descubres tu verdadera fuerza. No te rindas."
            },
            level_2: {
                pt: "A adversidade não é um castigo, é um treinamento. Use este momento de falha para temperar seu caráter.",
                en: "Adversity is not punishment, it is training. Use this moment of failure to temper your character.",
                es: "La adversidad no es un castigo, es un entrenamiento. Usa este momento de fallo para templar tu carácter."
            },
            level_3: {
                pt: "O fogo prova o ouro.",
                en: "Fire tests gold.",
                es: "El fuego prueba el oro."
            }
        }
    },
    {
        id: "cit_marco_identidade_01",
        author: "marcusAurelius",
        original_text: {
            pt: "Cave dentro de si. Dentro está a fonte do bem, e ela sempre jorrará se você sempre cavar.",
            en: "Dig within. Within is the wellspring of good; and it is always ready to bubble up, if you just dig.",
            es: "Cava dentro de ti. Dentro está la fuente del bien, y siempre brotará si siempre cavas."
        },
        source: "Meditações, VII.59",
        metadata: {
            virtue: "Wisdom",
            level: 2,
            discipline: "Desire",
            sphere: "Mental",
            tags: ["healing", "identity", "virtue", "potential", "hope", "will", "recovery", "resilience"],
            coercion_type: "Inspirational"
        },
        adaptations: {
            level_1: {
                pt: "Não procure a felicidade fora. Você tem tudo o que precisa dentro de você para ser uma pessoa boa.",
                en: "Don't look for happiness outside. You have everything you need inside you to be a good person.",
                es: "No busques la felicidad fuera. Tienes todo lo que necesitas dentro de ti para ser una buena persona."
            },
            level_2: {
                pt: "O Hegemonikon (faculdade dirigente) é autossuficiente. A virtude não depende de circunstâncias externas.",
                en: "The Hegemonikon (ruling faculty) is self-sufficient. Virtue does not depend on external circumstances.",
                es: "El Hegemonikon (facultad rectora) es autosuficiente. La virtud no depende de circunstancias externas."
            },
            level_3: {
                pt: "A fonte está dentro.",
                en: "The source is within.",
                es: "La fuente está dentro."
            }
        }
    },
    {
        id: "cit_epicteto_papel_01",
        author: "epictetus",
        original_text: {
            pt: "Lembre-se de que você é um ator em uma peça... Sua função é atuar bem o papel designado; escolhê-lo cabe a outro.",
            en: "Remember that you are an actor in a drama... For this is your business, to act well the character assigned you; to choose it is another's.",
            es: "Recuerda que eres un actor en una obra... Tu función es representar bien el papel asignado; elegirlo corresponde a otro."
        },
        source: "Enchiridion, 17",
        metadata: {
            virtue: "Wisdom",
            level: 2,
            discipline: "Desire",
            sphere: "Social",
            tags: ["fate", "acceptance", "duty", "role", "resilience"],
            coercion_type: "Reflective"
        },
        adaptations: {
            level_1: {
                pt: "Não reclame da sua vida. Jogue com as cartas que recebeu e faça o melhor jogo possível.",
                en: "Don't complain about your life. Play the cards you were dealt and play the best game possible.",
                es: "No te quejes de tu vida. Juega con las cartas que te tocaron y haz el mejor juego posible."
            },
            level_2: {
                pt: "Amor Fati: Aceite o roteiro do destino. Sua excelência não está no que acontece, mas em como você performa seu papel.",
                en: "Amor Fati: Accept fate's script. Your excellence is not in what happens, but in how you perform your role.",
                es: "Amor Fati: Acepta el guion del destino. Tu excelencia no está en lo que sucede, sino en cómo representas tu papel."
            },
            level_3: {
                pt: "Atue bem seu papel.",
                en: "Act your role well.",
                es: "Actúa bien tu papel."
            }
        }
    },
    {
        id: "cit_seneca_cura_01",
        author: "seneca",
        original_text: {
            pt: "É parte da cura o desejo de ser curado.",
            en: "It is part of the cure to wish to be cured.",
            es: "Es parte de la cura el deseo de ser curado."
        },
        source: "Fedra, 249",
        metadata: {
            virtue: "Courage",
            level: 1,
            discipline: "Desire",
            sphere: "Mental",
            tags: ["healing", "mindset", "will", "recovery", "resilience"],
            coercion_type: "Inspirational"
        },
        adaptations: {
            level_1: {
                pt: "Reconhecer que você precisa mudar é o primeiro passo para a mudança.",
                en: "Acknowledging that you need to change is the first step to change.",
                es: "Reconocer que necesitas cambiar es el primer paso para el cambio."
            },
            level_2: {
                pt: "A vontade ativa direcionada à virtude já é o início da virtude. Não subestime sua intenção.",
                en: "Active will directed towards virtue is already the beginning of virtue. Do not underestimate your intention.",
                es: "La voluntad activa dirigida hacia la virtud ya es el comienzo de la virtud. No subestimes tu intención."
            },
            level_3: {
                pt: "Desejar a cura é cura.",
                en: "To wish for cure is cure.",
                es: "Desear la cura es cura."
            }
        }
    },
    {
        id: "cit_seneca_infelicidade_01",
        author: "seneca",
        original_text: {
            pt: "Ninguém é mais infeliz do que aquele a quem a adversidade esqueceu, pois não lhe foi permitido provar-se.",
            en: "No man is more unhappy than he who has never faced adversity. For he is not permitted to prove himself.",
            es: "Nadie es más infeliz que aquel a quien la adversidad olvida, pues no se le permite probarse a sí mismo."
        },
        source: "De Providentia, III",
        metadata: {
            virtue: "Courage",
            level: 3,
            discipline: "Action",
            sphere: "Structural",
            tags: ["resilience", "suffering", "potential", "strength", "fate"],
            coercion_type: "Reflective"
        },
        adaptations: {
            level_1: {
                pt: "Os problemas são testes. Sem eles, você nunca saberia do que é capaz.",
                en: "Problems are tests. Without them, you would never know what you are capable of.",
                es: "Los problemas son pruebas. Sin ellos, nunca sabrías de lo que eres capaz."
            },
            level_2: {
                pt: "Uma vida sem desafios é uma tragédia, pois deixa a virtude adormecida. Abrace a luta.",
                en: "A life without challenges is a tragedy, for it leaves virtue dormant. Embrace the struggle.",
                es: "Una vida sin desafíos es una tragedia, pues deja la virtud dormida. Abraza la lucha."
            },
            level_3: {
                pt: "Prove-se na adversidade.",
                en: "Prove yourself in adversity.",
                es: "Pruébate en la adversidad."
            }
        }
    },
    {
        id: "cit_musonio_esforco_01",
        author: "musoniusRufus",
        original_text: {
            pt: "Se você trabalhar duro para fazer o que é certo, a dor passa, mas o bem permanece.",
            en: "If you accomplish something good with hard work, the labor passes, but the good remains.",
            es: "Si logras algo bueno con trabajo duro, el esfuerzo pasa, pero el bien permanece."
        },
        source: "Fragmentos",
        metadata: {
            virtue: "Courage",
            level: 2,
            discipline: "Action",
            sphere: "Structural",
            tags: ["endurance", "pain", "pleasure", "virtue", "legacy"],
            coercion_type: "Inspirational"
        },
        adaptations: {
            level_1: {
                pt: "O cansaço de hoje é temporário, mas o orgulho de ter feito o certo dura para sempre.",
                en: "Today's tiredness is temporary, but the pride of having done right lasts forever.",
                es: "El cansancio de hoy es temporal, pero el orgullo de haber hecho lo correcto dura para siempre."
            },
            level_2: {
                pt: "Troque o prazer imediato pela satisfação duradoura. O esforço se dissipa, a virtude se acumula.",
                en: "Trade immediate pleasure for lasting satisfaction. Effort dissipates, virtue accumulates.",
                es: "Cambia el placer inmediato por la satisfacción duradera. El esfuerzo se disipa, la virtud se acumula."
            },
            level_3: {
                pt: "A dor passa, o bem fica.",
                en: "Pain passes, good remains.",
                es: "El dolor pasa, el bien queda."
            }
        }
    }
];

// --- CATEGORY 4: EQUILIBRIUM & TEMPERANCE (The Balance) ---
// Foco: Humildade, Gratidão, Suficiência, Arrogância.
const EQUILIBRIUM_QUOTES: Quote[] = [
    {
        id: "cit_marco_aceitacao_03",
        author: "marcusAurelius",
        original_text: {
            pt: "Receba sem orgulho, largue sem apego.",
            en: "Receive without pride, let go without attachment.",
            es: "Recibe sin orgullo, suelta sin apego."
        },
        source: "Meditações, VIII.33",
        metadata: {
            virtue: "Temperance",
            level: 3,
            discipline: "Desire",
            sphere: "Mental",
            tags: ["humility", "wealth", "fortune", "acceptance", "simplicity"],
            coercion_type: "Dogmatic"
        },
        adaptations: {
            level_1: {
                pt: "Se venceu hoje, não se gabe. Se perdeu algo, não reclame. Mantenha o equilíbrio.",
                en: "If you won today, don't boast. If you lost something, don't complain. Keep your balance.",
                es: "Si ganaste hoy, no presumas. Si perdiste algo, no te quejes. Mantén el equilibrio."
            },
            level_2: {
                pt: "Trate o sucesso como um empréstimo da Fortuna, não como mérito eterno. Esteja pronto para devolvê-lo.",
                en: "Treat success as a loan from Fortune, not eternal merit. Be ready to return it.",
                es: "Trata el éxito como un préstamo de la Fortuna, no como mérito eterno. Prepárate para devolverlo."
            },
            level_3: {
                pt: "Sem orgulho, sem apego.",
                en: "No pride, no attachment.",
                es: "Sin orgullo, sin apego."
            }
        }
    },
    {
        id: "cit_epicteto_gratidao_01",
        author: "epictetus",
        original_text: {
            pt: "É um homem sábio aquele que não se entristece pelas coisas que não tem, mas se alegra com as que tem.",
            en: "He is a wise man who does not grieve for the things which he has not, but rejoices for those which he has.",
            es: "Es un hombre sabio el que no se entristece por las cosas que no tiene, sino que se alegra por las que tiene.",
        },
        source: "Fragmentos",
        metadata: {
            virtue: "Justice",
            level: 1,
            discipline: "Desire",
            sphere: "Mental",
            tags: ["gratitude", "happiness", "perspective", "acceptance", "evening", "resilience"],
            coercion_type: "Inspirational"
        },
        adaptations: {
            level_1: {
                pt: "Agradeço o que tenho e aceito o que o destino me traz. A gratidão é o reconhecimento da ordem universal.",
                en: "I am grateful for what I have and accept what fate brings. Gratitude is the recognition of universal order.",
                es: "Agradezco lo que tengo y acepto lo que el destino me trae. La gratitud es el reconocimiento del orden universal."
            },
            level_2: {
                pt: "Não foque na falta, mas na suficiência. A alegria vem de apreciar o presente como uma dádiva.",
                en: "Do not focus on lack, but on sufficiency. Joy comes from appreciating the present as a gift.",
                es: "No te enfoques en la falta, sino en la suficiencia. La alegría viene de apreciar el presente como un regalo."
            },
            level_3: {
                pt: "Eucharistia: Ação de Graças.",
                en: "Eucharistia: Thanksgiving.",
                es: "Eucharistia: Acción de Gracias."
            }
        }
    },
    {
        id: "cit_epicteto_abstine_01",
        author: "epictetus",
        original_text: {
            pt: "Nenhum homem é livre se não é dono de si mesmo.",
            en: "No man is free who is not master of himself.",
            es: "Ningún hombre es libre si no es dueño de sí mismo.",
        },
        source: "Fragmentos",
        metadata: {
            virtue: "Temperance",
            level: 1,
            discipline: "Desire",
            sphere: "Mental",
            tags: ["freedom", "control", "desire", "temperance", "discipline", "strength"],
            coercion_type: "Dogmatic"
        },
        adaptations: {
            level_1: {
                pt: "Eu escolho o que não fazer para ser dono do que eu sou.",
                en: "I choose what not to do to be master of who I am.",
                es: "Elijo qué no hacer para ser dueño de lo que soy."
            },
            level_2: {
                pt: "Liberdade não é fazer o que se quer, mas ter poder sobre o que se deseja. Negue o impulso para afirmar a razão.",
                en: "Freedom is not doing what you want, but having power over what you desire. Deny the impulse to affirm reason.",
                es: "La libertad no es hacer lo que se quiere, sino tener poder sobre lo que se desea. Niega el impulso para afirmar la razón."
            },
            level_3: {
                pt: "Abster-se é liberdade.",
                en: "To abstain is freedom.",
                es: "Abstenerse es libertad."
            }
        }
    },
    {
        id: "cit_musonio_rufo_nutricao_01",
        author: "musoniusRufus",
        original_text: {
            pt: "Que o alimento seja para o corpo o que a filosofia é para a alma: sustento, não luxo.",
            en: "Let food be for the body what philosophy is for the soul: sustenance, not luxury.",
            es: "Que el alimento sea para el cuerpo lo que la filosofía es para el alma: sustento, no lujo.",
        },
        source: "Fragmentos",
        metadata: {
            virtue: "Temperance",
            level: 1,
            discipline: "Desire",
            sphere: "Biological",
            tags: ["temperance", "health", "simplicity", "discipline", "body", "humility"],
            coercion_type: "Dogmatic"
        },
        adaptations: {
            level_1: {
                pt: "Lembre-se de comer para viver, não viver para comer. Escolha o que nutre, não apenas o que agrada.",
                en: "Remember to eat to live, not live to eat. Choose what nourishes, not just what pleases.",
                es: "Recuerda comer para vivir, no vivir para comer. Elige lo que nutre, no solo lo que agrada."
            },
            level_2: {
                pt: "Seu corpo é uma ferramenta. Abasteça-o com intenção, assim como você alimenta sua mente com ideias virtuosas.",
                en: "Your body is a tool. Fuel it with intention, just as you feed your mind with virtuous ideas.",
                es: "Tu cuerpo es una herramienta. Abastécelo con intención, así como alimentas tu mente con ideas virtuosas."
            },
            level_3: {
                pt: "Sustento, não luxo.",
                en: "Sustenance, not luxury.",
                es: "Sustento, no lujo."
            }
        }
    },
    {
        id: "cit_seneca_paupertas_01",
        author: "seneca",
        original_text: {
            pt: "Reserve um certo número de dias, durante os quais você se contentará com a alimentação mais escassa e barata, com roupas grossas e ásperas, dizendo a si mesmo: 'É esta a condição que eu temia?'",
            en: "Set aside a certain number of days, during which you shall be content with the scantiest and cheapest fare, with coarse and rough dress, saying to yourself the while: 'Is this the condition that I feared?'",
            es: "Reserva un cierto número de días, durante los cuales te contentarás con la comida más escasa y barata, con vestidos toscos y ásperos, diciéndote a ti mismo: '¿Es esta la condición que temía?'",
        },
        source: "Cartas a Lucílio, XVIII",
        metadata: {
            virtue: "Courage",
            level: 1,
            discipline: "Desire",
            sphere: "Biological",
            tags: ["resilience", "temperance", "fear", "poverty", "discomfort", "humility"],
            coercion_type: "Directive"
        },
        adaptations: {
            level_1: {
                pt: "Pratique a pobreza e o desconforto voluntariamente. Ao enfrentar o que você teme em pequenas doses, você percebe que é capaz de suportar.",
                en: "Practice poverty and discomfort voluntarily. By facing what you fear in small doses, you realize you can endure it.",
                es: "Practica la pobreza y la incomodidad voluntariamente. Al enfrentar lo que temes en pequeñas dosis, te das cuenta de que puedes soportarlo."
            },
            level_2: {
                pt: "O medo da escassez é pior que a escassez. Treine-se para precisar de pouco e você será livre.",
                en: "The fear of scarcity is worse than scarcity itself. Train yourself to need little, and you will be free.",
                es: "El miedo a la escasez es peor que la escasez misma. Entrénate para necesitar poco y serás libre."
            },
            level_3: {
                pt: "É isso que eu temia?",
                en: "Is this what I feared?",
                es: "¿Es esto lo que temía?"
            }
        }
    },
    {
        id: "cit_marco_presenca_01",
        author: "marcusAurelius",
        original_text: {
            pt: "Dê a si mesmo um presente: o momento presente.",
            en: "Give yourself a gift: the present moment.",
            es: "Date un regalo: el momento presente.",
        },
        source: "Meditações", 
        metadata: {
            virtue: "Temperance",
            level: 1,
            discipline: "Desire",
            sphere: "Biological",
            tags: ["focus", "presence", "mindfulness", "breath", "morning", "gratitude"],
            coercion_type: "Inspirational"
        },
        adaptations: {
            level_1: {
                pt: "Se eu domino a minha presença no agora através do fôlego, eu domino a minha primeira reação ao mundo.",
                en: "If I master my presence in the now through breath, I master my first reaction to the world.",
                es: "Si domino mi presencia en el ahora a través del aliento, domino mi primera reacción al mundo."
            },
            level_2: {
                pt: "A respiração é a âncora da alma. Volte a ela e encontre a ordem em meio ao caos.",
                en: "Breath is the anchor of the soul. Return to it and find order amidst chaos.",
                es: "La respiración es el ancla del alma. Vuelve a ella y encuentra orden en medio del caos."
            },
            level_3: {
                pt: "Fôlego é domínio.",
                en: "Breath is mastery.",
                es: "El aliento es dominio."
            }
        }
    },
    {
        id: "cit_marco_raiva_01",
        author: "marcusAurelius",
        original_text: {
            pt: "Quão mais graves são as consequências da raiva do que as suas causas.",
            en: "How much more grievous are the consequences of anger than the causes of it.",
            es: "Cuánto más graves son las consecuencias de la ira que sus causas."
        },
        source: "Meditações, XI.18",
        metadata: {
            virtue: "Temperance",
            level: 2,
            discipline: "Assent",
            sphere: "Social",
            tags: ["anger", "patience", "emotion", "judgment", "consequences"],
            coercion_type: "Reflective"
        },
        adaptations: {
            level_1: {
                pt: "Ficar com raiva só piora a situação. Respire fundo e não reaja agora.",
                en: "Getting angry only makes the situation worse. Take a deep breath and don't react now.",
                es: "Enojarse solo empeora la situación. Respira hondo y no reacciones ahora."
            },
            level_2: {
                pt: "A ofensa é externa; a raiva é interna. Não adicione seu próprio dano ao dano que o mundo lhe causou.",
                en: "The offense is external; anger is internal. Do not add your own harm to the harm the world has caused you.",
                es: "La ofensa es externa; la ira es interna. No añadas tu propio daño al daño que el mundo te ha causado."
            },
            level_3: {
                pt: "A raiva fere mais que a ofensa.",
                en: "Anger hurts more than the offense.",
                es: "La ira hiere más que la ofensa."
            }
        }
    }
];

// --- CATEGORY 5: SOCIAL & JUSTICE (The Commons) ---
// Foco: Bem Comum, Amizade, Raiva, Liderança.
const SOCIAL_QUOTES: Quote[] = [
    {
        id: "cit_marco_zelo_01",
        author: "marcusAurelius",
        original_text: {
            pt: "O que não é bom para a colmeia não pode ser bom para a abelha.",
            en: "That which is not good for the swarm, neither is it good for the bee.",
            es: "Lo que no es bueno para la colmena no puede ser bueno para la abeja.",
        },
        source: "Meditações, VI.54",
        metadata: {
            virtue: "Justice",
            level: 1,
            discipline: "Action",
            sphere: "Social",
            tags: ["community", "duty", "justice", "nature", "humility"],
            coercion_type: "Directive"
        },
        adaptations: {
            level_1: {
                pt: "Eu ajo para o bem comum, pois o que é bom para a colmeia é bom para a abelha.",
                en: "I act for the common good, for what is good for the swarm is good for the bee.",
                es: "Actúo por el bien común, pues lo que es bueno para la colmena es bueno para la abeja."
            },
            level_2: {
                pt: "Sua natureza é social. Trabalhar pelo outro é trabalhar por si mesmo. Não se isole da humanidade.",
                en: "Your nature is social. To work for another is to work for yourself. Do not isolate yourself from humanity.",
                es: "Tu naturaleza es social. Trabajar por el otro es trabajar por ti mismo. No te aísles de la humanidad."
            },
            level_3: {
                pt: "Bem comum, bem próprio.",
                en: "Common good, own good.",
                es: "Bien común, bien propio."
            }
        }
    },
    {
        id: "cit_hierocles_circulos_01",
        author: "hierocles",
        original_text: {
            pt: "Cada um de nós está, por assim dizer, circunscrito por muitos círculos concêntricos... É tarefa de um homem bem-intencionado e justo atrair os círculos para o centro.",
            en: "Each one of us is as it were entirely encompassed by many circles... It is the task of a well-tempered man, in his proper treatment of each class, to draw the circles together somehow towards the centre.",
            es: "Cada uno de nosotros está, por así decirlo, circunscrito por muchos círculos concéntricos... Es tarea de un hombre bien intencionado y justo atraer los círculos hacia el centro.",
        },
        source: "Sobre os Deveres",
        metadata: {
            virtue: "Justice",
            level: 2,
            discipline: "Action",
            sphere: "Social",
            tags: ["community", "love", "duty", "kindness", "humility"],
            coercion_type: "Directive"
        },
        adaptations: {
            level_1: {
                pt: "Cultivo minhas relações próximas como um dever sagrado. Tratar bem os meus é o início da justiça universal.",
                en: "I cultivate my close relationships as a sacred duty. Treating my own well is the beginning of universal justice.",
                es: "Cultivo mis relaciones cercanas como un deber sagrado. Tratar bien a los míos es el comienzo de la justicia universal."
            },
            level_2: {
                pt: "Traga os distantes para perto. Veja sua família e amigos não como externos, mas como partes de você.",
                en: "Draw the distant near. See your family and friends not as external, but as parts of yourself.",
                es: "Trae a los distantes cerca. Ve a tu familia y amigos no como externos, sino como partes de ti."
            },
            level_3: {
                pt: "Oikeiosis: Apropriação Social.",
                en: "Oikeiosis: Social Appropriation.",
                es: "Oikeiosis: Apropiación Social."
            }
        }
    },
    {
        id: "cit_marco_ser_01",
        author: "marcusAurelius",
        original_text: {
            pt: "Não discuta mais sobre como deve ser um homem bom. Seja um.",
            en: "Waste no more time arguing about what a good man should be. Be one.",
            es: "No pierdas más tiempo discutiendo sobre cómo debe ser un hombre bueno. Sé uno."
        },
        source: "Meditações, X.16",
        metadata: {
            virtue: "Justice",
            level: 3,
            discipline: "Action",
            sphere: "Social",
            tags: ["action", "discipline", "consistency", "virtue", "character"],
            coercion_type: "Directive"
        },
        adaptations: {
            level_1: {
                pt: "Chega de planejar como vai ser sua rotina perfeita. Apenas execute a próxima tarefa correta.",
                en: "Stop planning your perfect routine. Just execute the next right task.",
                es: "Basta de planear tu rutina perfecta. Solo ejecuta la siguiente tarea correcta."
            },
            level_2: {
                pt: "A filosofia não está no discurso, mas na conduta. A virtude só existe quando manifestada em 'Praxis'.",
                en: "Philosophy is not in speech, but in conduct. Virtue only exists when manifested in 'Praxis'.",
                es: "La filosofía no está en el discurso, sino en la conducta. La virtud solo existe cuando se manifiesta en 'Praxis'."
            },
            level_3: {
                pt: "Não fale, aja.",
                en: "Don't speak, act.",
                es: "No hables, actúa."
            }
        }
    },
    {
        id: "cit_epicteto_cidadao_01",
        author: "epictetus",
        original_text: {
            pt: "Você é um cidadão do mundo.",
            en: "You are a citizen of the world.",
            es: "Eres un ciudadano del mundo."
        },
        source: "Discursos, II.10",
        metadata: {
            virtue: "Justice",
            level: 2,
            discipline: "Action",
            sphere: "Social",
            tags: ["community", "duty", "cosmopolitanism", "identity", "nature"],
            coercion_type: "Reflective"
        },
        adaptations: {
            level_1: {
                pt: "Não se isole. Você faz parte de algo maior que sua casa ou cidade.",
                en: "Do not isolate yourself. You are part of something bigger than your home or city.",
                es: "No te aísles. Eres parte de algo más grande que tu hogar o ciudad."
            },
            level_2: {
                pt: "Sua racionalidade o conecta a todos os outros seres racionais. Aja como parte do todo.",
                en: "Your rationality connects you to all other rational beings. Act as part of the whole.",
                es: "Tu racionalidad te conecta con todos los demás seres racionales. Actúa como parte del todo."
            },
            level_3: {
                pt: "Kosmopolites.",
                en: "Kosmopolites.",
                es: "Kosmopolites."
            }
        }
    },
    {
        id: "cit_seneca_amizade_01",
        author: "seneca",
        original_text: {
            pt: "Pondere por muito tempo se deve admitir alguém como amigo; mas quando decidir, receba-o de todo o coração.",
            en: "Ponder for a long time whether you shall admit a given person to your friendship; but when you have decided to admit him, welcome him with all your heart and soul.",
            es: "Pondera por mucho tiempo si debes admitir a alguien como amigo; pero cuando decidas, recíbelo de todo corazón."
        },
        source: "Cartas a Lucílio, III",
        metadata: {
            virtue: "Justice",
            level: 2,
            discipline: "Action",
            sphere: "Social",
            tags: ["friendship", "trust", "loyalty", "heart", "community"],
            coercion_type: "Directive"
        },
        adaptations: {
            level_1: {
                pt: "Escolha bem seus amigos, mas depois que escolher, confie neles totalmente.",
                en: "Choose your friends well, but once you choose, trust them completely.",
                es: "Elige bien a tus amigos, pero una vez que elijas, confía en ellos totalmente."
            },
            level_2: {
                pt: "A confiança é a alma da amizade. A dúvida constante é veneno para as relações.",
                en: "Trust is the soul of friendship. Constant doubt is poison to relationships.",
                es: "La confianza es el alma de la amistad. La duda constante es veneno para las relaciones."
            },
            level_3: {
                pt: "Confiança total ou nenhuma.",
                en: "Total trust or none.",
                es: "Confianza total o ninguna."
            }
        }
    },
    {
        id: "cit_marco_humanidade_01",
        author: "marcusAurelius",
        original_text: {
            pt: "Os homens existem uns para os outros.",
            en: "Men exist for the sake of one another.",
            es: "Los hombres existen unos para otros."
        },
        source: "Meditações, VIII.59",
        metadata: {
            virtue: "Justice",
            level: 1,
            discipline: "Action",
            sphere: "Social",
            tags: ["community", "kindness", "patience", "justice", "duty"],
            coercion_type: "Directive"
        },
        adaptations: {
            level_1: {
                pt: "Estamos todos conectados. Ajude os outros ou tenha paciência com eles.",
                en: "We are all connected. Help others or bear with them.",
                es: "Todos estamos conectados. Ayuda a los demás o ten paciencia con ellos."
            },
            level_2: {
                pt: "Sua função social é cooperar. A raiva contra o outro é uma falha contra a natureza humana.",
                en: "Your social function is to cooperate. Anger against another is a failure against human nature.",
                es: "Tu función social es cooperar. La ira contra el otro es una falla contra la naturaleza humana."
            },
            level_3: {
                pt: "Ensine ou tolere.",
                en: "Teach or tolerate.",
                es: "Enseña o tolera."
            }
        }
    },
    {
        id: "cit_marco_vinganca_01",
        author: "marcusAurelius",
        original_text: {
            pt: "A melhor vingança é ser diferente de quem causou o dano.",
            en: "The best revenge is to be unlike him who performed the injury.",
            es: "La mejor venganza es ser diferente a quien causó el daño."
        },
        source: "Meditações, VI.6",
        metadata: {
            virtue: "Justice",
            level: 3,
            discipline: "Action",
            sphere: "Social",
            tags: ["justice", "anger", "character", "forgiveness", "virtue"],
            coercion_type: "Directive"
        },
        adaptations: {
            level_1: {
                pt: "Não retribua o mal com o mal. Se alguém foi injusto, não se rebaixe ao nível dele.",
                en: "Do not repay evil with evil. If someone was unjust, do not lower yourself to their level.",
                es: "No devuelvas mal por mal. Si alguien fue injusto, no te rebajes a su nivel."
            },
            level_2: {
                pt: "A punição do vício é o próprio vício. Mantenha sua integridade e não deixe a maldade alheia corromper seu caráter.",
                en: "The punishment of vice is vice itself. Maintain your integrity and do not let others' malice corrupt your character.",
                es: "El castigo del vicio es el vicio mismo. Mantén tu integridad y no dejes que la maldad ajena corrompa tu carácter."
            },
            