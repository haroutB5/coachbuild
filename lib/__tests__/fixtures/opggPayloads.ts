// GENERATED FROM LIVE op.gg RESPONSES — 2026-07-27. Do not hand-edit.
//
// These are verbatim `result.content[0].text` payloads captured from
// POST https://mcp-api.op.gg/mcp (lol_get_champion_analysis). They exist so
// that a change in op.gg's payload shape fails a test here rather than
// silently mis-parsing in production.
//
// AHRI_MID_FULL and AHRI_MID_SLIM are the SAME champion, role and minute —
// the only difference is that the slim one was requested with
// `desired_output_fields`, which REORDERS the declared fields from
// `order,play,win,pick_rate` to `order,pick_rate,play,win`. Any parser that
// reads positions instead of names will disagree between these two.

/** Full response (no desired_output_fields): class Skills: order,play,win,pick_rate */
export const AHRI_MID_FULL = `class LolGetChampionAnalysis: champion,position,data
class Data: summary,damage_type,strong_counters,weak_counters,synergies,core_items,mythic_items,boots,starter_items,last_items,fourth_items,fifth_items,sixth_items,summoner_spells,runes,skills,skill_combos,skill_masteries,trends
class Summary: id,is_rotation,is_rip,average_stats,positions,roles
class AverageStats: play,win_rate,pick_rate,ban_rate,kda,tier,rank,tier_data
class TierData: tier,rank,rank_prev,rank_prev_patch
class Position: name,stats,roles,counters
class Stats: play,win_rate,pick_rate,role_rate,ban_rate,kda,tier_data
class Role: name,stats
class Stats1: win_rate,role_rate,play,win
class Counter: champion_id,champion_name,play,win
class StrongCounter: champion_id,champion_name,play,win,my_win_rate,counter_win_rate,win_rate
class Synergies: top,jungle,adc,support
class Top: champion_id,champion_name,position,synergy_champion_id,synergy_champion_name,synergy_position,score_rank,score,play,win,win_rate,synergy_tier_data
class CoreItems: ids,ids_names,play,win,pick_rate
class Runes: id,primary_page_id,primary_page_name,primary_rune_ids,primary_rune_names,secondary_page_id,secondary_page_name,secondary_rune_ids,secondary_rune_names,stat_mod_ids,stat_mod_names,play,win,pick_rate
class Skills: order,play,win,pick_rate
class SkillCombo: name,video_url
class SkillMasteries: ids,play,win,pick_rate,builds
class Trends: total_rank,total_position_rank,win,pick,ban
class Win: version,rate,rank,created_at

LolGetChampionAnalysis("AHRI","MID",Data(Summary(103,false,false,AverageStats(200343,0.51,0.1,0.03,2.54,1,12,TierData(1,12,12,14)),[Position("MID",Stats(190917,0.51,0.09,0.95,0.03,2.55,TierData(1,2,2,3)),[Role("MAGE",Stats1(0.51,1,183926,94271))],[Counter(1,"Annie",2343,1120),Counter(238,"Zed",6164,3034),Counter(18,"Tristana",583,287)])],[]),"AP",[StrongCounter(268,"Azir",1513,857,0.57,0.43,0.57),StrongCounter(92,"Riven",796,456,0.57,0.43,0.57),StrongCounter(901,"Smolder",323,180,0.56,0.44,0.56)],[StrongCounter(1,"Annie",2343,1120,0.48,0.52,0.52),StrongCounter(238,"Zed",6164,3034,0.49,0.51,0.51),StrongCounter(805,"Locke",5353,2645,0.49,0.51,0.51)],Synergies([Top(103,"Ahri","MID",41,"Gangplank","TOP",3,0,1463,785,0.54,TierData(1,3,3,1)),Top(103,"Ahri","MID",39,"Irelia","TOP",8,0,1071,565,0.53,TierData(1,4,5,7)),Top(103,"Ahri","MID",24,"Jax","TOP",7,0,1090,562,0.52,TierData(2,13,13,5))],[Top(103,"Ahri","MID",517,"Sylas","JUNGLE",4,0,1782,931,0.52,TierData(1,7,5,3)),Top(103,"Ahri","MID",5,"Xin Zhao","JUNGLE",8,0,1126,587,0.52,TierData(2,16,15,21)),Top(103,"Ahri","MID",62,"Wukong","JUNGLE",9,0,1068,547,0.51,TierData(1,3,3,2))],[Top(103,"Ahri","MID",21,"Miss Fortune","ADC",9,0,1159,621,0.54,TierData(3,20,20,18)),Top(103,"Ahri","MID",18,"Tristana","ADC",10,0,1151,592,0.51,TierData(2,7,7,6)),Top(103,"Ahri","MID",115,"Ziggs","ADC",6,0,1726,886,0.51,TierData(1,2,2,9))],[Top(103,"Ahri","MID",89,"Leona","SUPPORT",7,0,1355,718,0.53,TierData(1,3,3,2)),Top(103,"Ahri","MID",555,"Pyke","SUPPORT",4,0,1586,832,0.52,TierData(2,8,8,10)),Top(103,"Ahri","MID",432,"Bard","SUPPORT",6,0,1455,760,0.52,TierData(2,9,9,12))]),CoreItems([3118,4645,3157],["Malignance","Shadowflame","Zhonya's Hourglass"],14604,7614,0.13),[],CoreItems([3020],["Sorcerer's Shoes"],100006,51522,0.56),CoreItems([1056,2003,2003],["Doran's Ring","Health Potion","Health Potion"],181135,92817,0.99),[CoreItems([3118],["Malignance"],121463,62292,0.66),CoreItems([4645],["Shadowflame"],88975,46740,0.48),CoreItems([3157],["Zhonya's Hourglass"],59289,32761,0.32)],[CoreItems([3089],["Rabadon's Deathcap"],15878,9332,0.32),CoreItems([3157],["Zhonya's Hourglass"],12119,7222,0.25),CoreItems([3135],["Void Staff"],4567,2433,0.09)],[CoreItems([3089],["Rabadon's Deathcap"],2595,1662,0.2),CoreItems([3135],["Void Staff"],2257,1256,0.17),CoreItems([3157],["Zhonya's Hourglass"],2142,1323,0.16)],[CoreItems([4629],["Cosmic Drive"],49,26,0.18),CoreItems([4646],["Stormsurge"],33,15,0.12),CoreItems([3135],["Void Staff"],31,15,0.11)],CoreItems([4,14],[4,14],93978,49510,0.51),Runes(8112,8100,"Domination",[8112,8139,8140,8106],["Electrocute","Taste of Blood","Grisly Mementos","Ultimate Hunter"],8200,"Sorcery",[8210,8226],["Transcendence","Manaflow Band"],[5005,5008,5001],[5005,5008,5001],87713,44187,0.47),Skills(["W","Q","E","Q","Q","R","Q","W","Q","W","R","W","W","E","E"],71667,41408,0.57),[SkillCombo("A + W + A","https://www.youtube.com/watch?v=P8nIVrnXo88"),SkillCombo("Q + Flash","https://www.youtube.com/watch?v=uern-Y1gR3A"),SkillCombo("E + Flash","https://www.youtube.com/watch?v=H3c3Kqd2beI"),SkillCombo("E + Q + W + A","https://www.youtube.com/watch?v=dgL1f8hVwPY"),SkillCombo("R+A+W+Q+E+A+R+A+R","https://www.youtube.com/watch?v=LtPRneOgI_0")],SkillMasteries(["Q","W","E"],116034,67041,0.92,[Skills(["W","Q","E","Q","Q","R","Q","W","Q","W","R","W","W","E","E"],71667,41408,0.62),Skills(["Q","W","E","Q","Q","R","Q","W","Q","W","R","W","W","E","E"],12917,7391,0.11),Skills(["W","E","Q","Q","Q","R","Q","W","Q","W","R","W","W","E","E"],9541,5603,0.08),Skills(["W","Q","Q","E","Q","R","Q","W","Q","W","R","W","W","E","E"],3097,1812,0.03),Skills(["Q","E","W","Q","Q","R","Q","W","Q","W","R","W","W","E","E"],3025,1738,0.03)]),Trends(173,56,Win("16.14",0.51,9,"2026-07-25T22:39:28+09:00"),Win("16.14",0.09,1,"2026-07-25T22:39:28+09:00"),Win("16.14",0.03,30,"2026-07-25T22:39:28+09:00"))))`;

/** Slim response (with desired_output_fields): class Skills: order,pick_rate,play,win */
export const AHRI_MID_SLIM = `class LolGetChampionAnalysis: champion,position,data
class Data: skills,skill_masteries
class Skills: order,pick_rate,play,win
class SkillMasteries: ids,pick_rate,play,win,builds

LolGetChampionAnalysis("AHRI","MID",Data(Skills(["W","Q","E","Q","Q","R","Q","W","Q","W","R","W","W","E","E"],0.57,71667,41408),SkillMasteries(["Q","W","E"],0.92,116034,67041,[Skills(["W","Q","E","Q","Q","R","Q","W","Q","W","R","W","W","E","E"],0.62,71667,41408),Skills(["Q","W","E","Q","Q","R","Q","W","Q","W","R","W","W","E","E"],0.11,12917,7391),Skills(["W","E","Q","Q","Q","R","Q","W","Q","W","R","W","W","E","E"],0.08,9541,5603),Skills(["W","Q","Q","E","Q","R","Q","W","Q","W","R","W","W","E","E"],0.03,3097,1812),Skills(["Q","E","W","Q","Q","R","Q","W","Q","W","R","W","W","E","E"],0.03,3025,1738)])))`;

/** Udyr: four basics, no true ultimate. Q and E reach SIX ranks by level 15
 *  and "R" is ranked at level 2 — not the standard 5/5/5/3 model. */
export const UDYR_JUNGLE = `class LolGetChampionAnalysis: champion,position,data
class Data: summary,damage_type,strong_counters,weak_counters,synergies,core_items,mythic_items,boots,starter_items,last_items,fourth_items,fifth_items,sixth_items,summoner_spells,runes,skills,skill_combos,skill_masteries,trends
class Summary: id,is_rotation,is_rip,average_stats,positions,roles
class AverageStats: play,win_rate,pick_rate,ban_rate,kda,tier,rank,tier_data
class TierData: tier,rank,rank_prev,rank_prev_patch
class Position: name,stats,roles,counters
class Stats: play,win_rate,pick_rate,role_rate,ban_rate,kda,tier_data
class Role: name,stats
class Stats1: win_rate,role_rate,play,win
class Counter: champion_id,champion_name,play,win
class StrongCounter: champion_id,champion_name,play,win,my_win_rate,counter_win_rate,win_rate
class Synergies: top,mid,adc,support
class Top: champion_id,champion_name,position,synergy_champion_id,synergy_champion_name,synergy_position,score_rank,score,play,win,win_rate,synergy_tier_data
class CoreItems: ids,ids_names,play,win,pick_rate
class Runes: id,primary_page_id,primary_page_name,primary_rune_ids,primary_rune_names,secondary_page_id,secondary_page_name,secondary_rune_ids,secondary_rune_names,stat_mod_ids,stat_mod_names,play,win,pick_rate
class Skills: order,play,win,pick_rate
class SkillCombo: name,video_url
class SkillMasteries: ids,play,win,pick_rate,builds
class Trends: total_rank,total_position_rank,win,pick,ban
class Win: version,rate,rank,created_at

LolGetChampionAnalysis("UDYR","JUNGLE",Data(Summary(77,false,false,AverageStats(59297,0.51,0.03,0.01,2.5,4,108,TierData(4,108,106,106)),[Position("JUNGLE",Stats(47196,0.52,0.02,0.8,0.01,2.72,TierData(3,17,17,21)),[Role("FIGHTER",Stats1(0.52,0.63,28766,14972)),Role("TANK",Stats1(0.5,0.22,9853,4969)),Role("MAGE",Stats1(0.53,0.12,5422,2858)),Role("MARKSMAN",Stats1(0.52,0.01,652,337)),Role("SLAYER",Stats1(0.49,0.01,507,247))],[Counter(33,"Rammus",316,139),Counter(19,"Warwick",704,319),Counter(122,"Darius",151,72)]),Position("TOP",Stats(10844,0.49,0.01,0.18,0.01,1.74,TierData(5,59,60,59)),[Role("TANK",Stats1(0.5,0.47,4894,2425)),Role("MAGE",Stats1(0.47,0.27,2851,1353)),Role("FIGHTER",Stats1(0.49,0.25,2565,1268))],[Counter(85,"Kennen",38,13),Counter(34,"Anivia",54,20),Counter(875,"Sett",261,106)])],[]),"BOTH",[StrongCounter(805,"Locke",431,254,0.59,0.41,0.59),StrongCounter(30,"Karthus",245,142,0.58,0.42,0.58),StrongCounter(126,"Jayce",235,133,0.57,0.43,0.57)],[StrongCounter(33,"Rammus",316,139,0.44,0.56,0.56),StrongCounter(19,"Warwick",704,319,0.45,0.55,0.55),StrongCounter(59,"Jarvan IV",1393,673,0.48,0.52,0.52)],Synergies([Top(77,"Udyr","JUNGLE",41,"Gangplank","TOP",4,0,146,85,0.58,TierData(1,3,3,1)),Top(77,"Udyr","JUNGLE",777,"Yone","TOP",1,0,209,116,0.56,TierData(1,7,6,9)),Top(77,"Udyr","JUNGLE",82,"Mordekaiser","TOP",3,0,149,80,0.54,TierData(1,2,1,51))],[Top(77,"Udyr","JUNGLE",4,"Twisted Fate","MID",5,0,142,85,0.6,TierData(1,2,2,4)),Top(77,"Udyr","JUNGLE",238,"Zed","MID",9,0,121,70,0.58,TierData(2,10,10,8)),Top(77,"Udyr","JUNGLE",103,"Ahri","MID",6,0,136,71,0.52,TierData(2,8,8,9))],[Top(77,"Udyr","JUNGLE",236,"Lucian","ADC",7,0,154,90,0.58,TierData(3,10,10,10)),Top(77,"Udyr","JUNGLE",101,"Xerath","ADC",2,0,264,153,0.58,TierData(1,1,1,5)),Top(77,"Udyr","JUNGLE",18,"Tristana","ADC",10,0,120,68,0.57,TierData(2,7,7,6))],[Top(77,"Udyr","JUNGLE",43,"Karma","SUPPORT",8,0,128,75,0.59,TierData(3,18,18,18)),Top(77,"Udyr","JUNGLE",164,"Camille","SUPPORT",2,0,210,114,0.54,TierData(1,4,4,11)),Top(77,"Udyr","JUNGLE",53,"Blitzcrank","SUPPORT",7,0,129,70,0.54,TierData(2,7,7,8))]),CoreItems([3161,3073,6333],["Spear of Shojin","Experimental Hexplate","Death's Dance"],4837,2715,0.15),[],CoreItems([3009],["Boots of Swiftness"],18590,9859,0.43),CoreItems([1102],["Gustwalker Hatchling"],19185,10028,0.42),[CoreItems([3161],["Spear of Shojin"],26526,13871,0.58),CoreItems([6333],["Death's Dance"],16323,9116,0.36),CoreItems([3073],["Experimental Hexplate"],12918,6967,0.28)],[CoreItems([3065],["Spirit Visage"],2772,1669,0.16),CoreItems([3742],["Dead Man's Plate"],1759,1085,0.1),CoreItems([6333],["Death's Dance"],1494,929,0.09)],[CoreItems([3065],["Spirit Visage"],610,386,0.1),CoreItems([6665],["Jak'Sho, The Protean"],565,339,0.1),CoreItems([3143],["Randuin's Omen"],468,254,0.08)],[CoreItems([3742],["Dead Man's Plate"],44,22,0.17),CoreItems([4401],["Force of Nature"],15,8,0.06),CoreItems([3026],["Guardian Angel"],15,11,0.06)],CoreItems([4,11],[4,11],40650,21099,0.89),Runes(8005,8000,"Precision",[8005,9111,9105,8014],["Press the Attack","Triumph","Legend: Haste","Coup de Grace"],8300,"Inspiration",[8304,8410],["Magical Footwear","Approach Velocity"],[5008,5008,5001],[5008,5008,5001],10384,5323,0.22),Skills(["Q","R","W","E","Q","Q","Q","E","Q","E","Q","E","E","E","W"],8815,5418,0.3),[SkillCombo("E + A + R","https://www.youtube.com/watch?v=UZiYplzDBxs"),SkillCombo("A + A + W + A + A+ W + A + A","https://www.youtube.com/watch?v=SMvH7ziqMOk"),SkillCombo("E + A + Q + AA + R + A + R","https://www.youtube.com/watch?v=T80ozWkR0hA"),SkillCombo("E+A+R+AA+W+AA+W+AA","https://www.youtube.com/watch?v=yDuAApVVSWU")],SkillMasteries(["Q","E","W","R"],15630,9599,0.53,[Skills(["Q","R","W","E","Q","Q","Q","E","Q","E","Q","E","E","E","W"],8783,5398,0.56),Skills(["R","Q","W","E","Q","Q","Q","E","Q","E","Q","E","E","E","W"],1163,716,0.07),Skills(["Q","R","E","W","Q","Q","Q","E","Q","E","Q","E","E","E","W"],813,505,0.05),Skills(["Q","R","W","E","Q","Q","Q","E","Q","E","E","Q","E","E","W"],508,300,0.03),Skills(["R","Q","E","W","Q","Q","Q","E","Q","E","Q","E","E","E","W"],434,266,0.03)]),Trends(173,63,Win("16.14",0.52,7,"2026-07-25T22:39:28+09:00"),Win("16.14",0.02,29,"2026-07-25T22:39:28+09:00"),Win("16.14",0.01,49,"2026-07-25T22:39:28+09:00"))))`;

/** Aphelios: W is a fixed 1-rank mechanic, so Q and E go to six ranks. */
export const APHELIOS_ADC = `class LolGetChampionAnalysis: champion,position,data
class Data: summary,damage_type,strong_counters,weak_counters,synergies,core_items,mythic_items,boots,starter_items,last_items,fourth_items,fifth_items,sixth_items,summoner_spells,runes,skills,skill_combos,skill_masteries,trends
class Summary: id,is_rotation,is_rip,average_stats,positions,roles
class AverageStats: play,win_rate,pick_rate,ban_rate,kda,tier,rank,tier_data
class TierData: tier,rank,rank_prev,rank_prev_patch
class Position: name,stats,roles,counters
class Stats: play,win_rate,pick_rate,role_rate,ban_rate,kda,tier_data
class Role: name,stats
class Stats1: win_rate,role_rate,play,win
class Counter: champion_id,champion_name,play,win
class StrongCounter: champion_id,champion_name,play,win,my_win_rate,counter_win_rate,win_rate
class Synergies: top,jungle,mid,support
class Top: champion_id,champion_name,position,synergy_champion_id,synergy_champion_name,synergy_position,score_rank,score,play,win,win_rate,synergy_tier_data
class CoreItems: ids,ids_names,play,win,pick_rate
class Runes: id,primary_page_id,primary_page_name,primary_rune_ids,primary_rune_names,secondary_page_id,secondary_page_name,secondary_rune_ids,secondary_rune_names,stat_mod_ids,stat_mod_names,play,win,pick_rate
class Skills: order,play,win,pick_rate
class SkillCombo: name,video_url
class SkillMasteries: ids,play,win,pick_rate,builds
class Trends: total_rank,total_position_rank,win,pick,ban
class Win: version,rate,rank,created_at

LolGetChampionAnalysis("APHELIOS","ADC",Data(Summary(523,false,false,AverageStats(88991,0.5,0.04,0.01,1.87,4,131,TierData(4,131,130,118)),[Position("ADC",Stats(87064,0.5,0.04,0.98,0.01,1.89,TierData(3,32,32,27)),[Role("MARKSMAN",Stats1(0.5,1,83638,41733))],[Counter(161,"Vel'Koz",418,174),Counter(99,"Lux",504,225),Counter(30,"Karthus",240,108)])],[]),"AD",[StrongCounter(67,"Vayne",1627,900,0.55,0.45,0.55),StrongCounter(145,"Kai'Sa",4864,2634,0.54,0.46,0.54),StrongCounter(81,"Ezreal",5053,2656,0.53,0.47,0.53)],[StrongCounter(161,"Vel'Koz",418,174,0.42,0.58,0.58),StrongCounter(101,"Xerath",1299,588,0.45,0.55,0.55),StrongCounter(45,"Veigar",613,277,0.45,0.55,0.55)],Synergies([Top(523,"Aphelios","ADC",36,"Dr. Mundo","TOP",10,0,655,343,0.52,TierData(3,20,20,19)),Top(523,"Aphelios","ADC",82,"Mordekaiser","TOP",1,0,1137,595,0.52,TierData(1,2,2,51)),Top(523,"Aphelios","ADC",266,"Aatrox","TOP",5,0,789,402,0.51,TierData(2,15,14,15))],[Top(523,"Aphelios","ADC",62,"Wukong","JUNGLE",10,0,683,365,0.53,TierData(2,3,3,2)),Top(523,"Aphelios","ADC",56,"Nocturne","JUNGLE",6,0,971,518,0.53,TierData(2,6,5,8)),Top(523,"Aphelios","ADC",64,"Lee Sin","JUNGLE",1,0,2977,1542,0.52,TierData(1,1,1,1))],[Top(523,"Aphelios","ADC",805,"Locke","MID",8,0,784,426,0.54,TierData(0,1,1,1)),Top(523,"Aphelios","ADC",84,"Akali","MID",4,0,994,538,0.54,TierData(2,14,13,16)),Top(523,"Aphelios","ADC",55,"Katarina","MID",10,0,693,359,0.52,TierData(1,5,5,3))],[Top(523,"Aphelios","ADC",53,"Blitzcrank","SUPPORT",4,0,985,534,0.54,TierData(2,7,7,8)),Top(523,"Aphelios","ADC",412,"Thresh","SUPPORT",1,0,4042,2120,0.52,TierData(1,5,5,1)),Top(523,"Aphelios","ADC",89,"Leona","SUPPORT",7,0,712,365,0.51,TierData(1,3,3,2))]),CoreItems([2523,3046,3031],["Hexoptics C44","Phantom Dancer","Infinity Edge"],8778,5102,0.15),[],CoreItems([3006],["Berserker's Greaves"],33658,16466,0.44),CoreItems([1086,2003,2003],["Doran's Bow","Health Potion","Health Potion"],58746,29333,0.7),[CoreItems([3031],["Infinity Edge"],67166,36533,0.8),CoreItems([2523],["Hexoptics C44"],39540,19940,0.47),CoreItems([3036],["Lord Dominik's Regards"],33952,19975,0.4)],[CoreItems([3036],["Lord Dominik's Regards"],7377,4784,0.21),CoreItems([6673],["Immortal Shieldbow"],7303,4439,0.2),CoreItems([3085],["Runaan's Hurricane"],5041,2860,0.14)],[CoreItems([3072],["Bloodthirster"],4818,3040,0.32),CoreItems([3026],["Guardian Angel"],4295,2789,0.28),CoreItems([3139],["Mercurial Scimitar"],1962,1213,0.13)],[CoreItems([3026],["Guardian Angel"],1721,1127,0.35),CoreItems([3072],["Bloodthirster"],1037,641,0.21),CoreItems([3139],["Mercurial Scimitar"],516,298,0.1)],CoreItems([4,21],[4,21],65900,33051,0.78),Runes(8005,8000,"Precision",[8005,9111,9103,8017],["Press the Attack","Triumph","Legend: Bloodline","Cut Down"],8300,"Inspiration",[8313,8321],["Triple Tonic","Cash Back"],[5005,5008,5011],[5005,5008,5011],24236,12346,0.28),Skills(["Q","Q","Q","E","Q","R","E","Q","E","Q","E","E","R","E","W"],11004,5957,0.18),[SkillCombo("[Calibrum] Q + A","https://www.youtube.com/watch?v=cKcekPqvmJc"),SkillCombo("A + Q","https://www.youtube.com/watch?v=45N8SNcChQI"),SkillCombo("R + Q + W + Q + A","https://www.youtube.com/watch?v=WL2guCYsqgc"),SkillCombo("A + Q + A + W + Q + A","https://www.youtube.com/watch?v=qHKBCJ_yn_4"),SkillCombo("Q + A + Q + AAA+ R +A","https://www.youtube.com/watch?v=kjxpYS3CcNI"),SkillCombo("Crescendum+Severum combo","https://www.youtube.com/watch?v=0FfGuz8VaRo"),SkillCombo("Q + W + A + A + R + A + Q","https://www.youtube.com/watch?v=rzLNUvRRc84"),SkillCombo("Expert combo","https://www.youtube.com/watch?v=ff1t2D1oY8k"),SkillCombo("Impossible combo","https://www.youtube.com/watch?v=zscla0wpXKE")],SkillMasteries(["Q","E","W"],47238,25468,0.76,[Skills(["Q","Q","Q","E","Q","R","E","Q","E","Q","E","E","R","E","W"],11004,5957,0.23),Skills(["Q","Q","Q","E","Q","R","E","Q","E","Q","E","R","E","E","W"],7525,4064,0.16),Skills(["W","Q","Q","Q","Q","R","E","Q","E","Q","E","R","E","E","E"],5943,3334,0.13),Skills(["W","Q","Q","Q","Q","R","E","Q","E","Q","E","E","R","E","E"],5598,3053,0.12),Skills(["W","Q","E","Q","Q","R","Q","Q","E","Q","E","E","R","E","E"],2838,1432,0.06)]),Trends(173,44,Win("16.14",0.5,36,"2026-07-25T22:39:28+09:00"),Win("16.14",0.04,19,"2026-07-25T22:39:28+09:00"),Win("16.14",0.01,30,"2026-07-25T22:39:28+09:00"))))`;

/** Kayn: flagged up front as a "form swapper" risk, but his ability RANKS are
 *  standard 5/5/5/3 — included to pin that he completes normally. */
export const KAYN_JUNGLE = `class LolGetChampionAnalysis: champion,position,data
class Data: summary,damage_type,strong_counters,weak_counters,synergies,core_items,mythic_items,boots,starter_items,last_items,fourth_items,fifth_items,sixth_items,summoner_spells,runes,skills,skill_combos,skill_masteries,trends
class Summary: id,is_rotation,is_rip,average_stats,positions,roles
class AverageStats: play,win_rate,pick_rate,ban_rate,kda,tier,rank,tier_data
class TierData: tier,rank,rank_prev,rank_prev_patch
class Position: name,stats,roles,counters
class Stats: play,win_rate,pick_rate,role_rate,ban_rate,kda,tier_data
class Role: name,stats
class Stats1: win_rate,role_rate,play,win
class Counter: champion_id,champion_name,play,win
class StrongCounter: champion_id,champion_name,play,win,my_win_rate,counter_win_rate,win_rate
class Synergies: top,mid,adc,support
class Top: champion_id,champion_name,position,synergy_champion_id,synergy_champion_name,synergy_position,score_rank,score,play,win,win_rate,synergy_tier_data
class CoreItems: ids,ids_names,play,win,pick_rate
class Runes: id,primary_page_id,primary_page_name,primary_rune_ids,primary_rune_names,secondary_page_id,secondary_page_name,secondary_rune_ids,secondary_rune_names,stat_mod_ids,stat_mod_names,play,win,pick_rate
class Skills: order,play,win,pick_rate
class SkillCombo: name,video_url
class SkillMasteries: ids,play,win,pick_rate,builds
class Trends: total_rank,total_position_rank,win,pick,ban
class Win: version,rate,rank,created_at

LolGetChampionAnalysis("KAYN","JUNGLE",Data(Summary(141,false,false,AverageStats(154111,0.51,0.08,0.05,2.34,2,28,TierData(2,28,27,38)),[Position("JUNGLE",Stats(147400,0.51,0.07,0.96,0.05,2.4,TierData(1,6,7,9)),[Role("SLAYER|ASSASSIN",Stats1(0.52,0.4,56542,29170)),Role("FIGHTER|SLAYER",Stats1(0.51,0.4,56212,28925)),Role("SLAYER|SLAYER",Stats1(0.5,0.16,22983,11571)),Role("TANK|SLAYER",Stats1(0.47,0.01,1649,774)),Role("FIGHTER|ASSASSIN",Stats1(0.45,0.01,1439,653))],[Counter(122,"Darius",377,172),Counter(421,"Rek'Sai",860,400),Counter(133,"Quinn",995,465)])],[]),"AD",[StrongCounter(36,"Dr. Mundo",419,235,0.56,0.44,0.56),StrongCounter(17,"Teemo",330,185,0.56,0.44,0.56),StrongCounter(805,"Locke",1487,823,0.55,0.45,0.55)],[StrongCounter(122,"Darius",377,172,0.46,0.54,0.54),StrongCounter(102,"Shyvana",2754,1302,0.47,0.53,0.53),StrongCounter(133,"Quinn",995,465,0.47,0.53,0.53)],Synergies([Top(141,"Kayn","JUNGLE",36,"Dr. Mundo","TOP",9,0,485,269,0.55,TierData(3,20,21,19)),Top(141,"Kayn","JUNGLE",82,"Mordekaiser","TOP",1,0,913,506,0.55,TierData(1,2,1,51)),Top(141,"Kayn","JUNGLE",54,"Malphite","TOP",7,0,524,288,0.55,TierData(1,8,8,2))],[Top(141,"Kayn","JUNGLE",4,"Twisted Fate","MID",3,0,789,446,0.57,TierData(1,2,2,4)),Top(141,"Kayn","JUNGLE",805,"Locke","MID",7,0,607,340,0.56,TierData(0,1,1,1)),Top(141,"Kayn","JUNGLE",238,"Zed","MID",10,0,485,253,0.52,TierData(2,10,10,8))],[Top(141,"Kayn","JUNGLE",236,"Lucian","ADC",8,0,705,380,0.54,TierData(3,10,10,10)),Top(141,"Kayn","JUNGLE",112,"Viktor","ADC",10,0,662,352,0.53,TierData(1,3,3,null)),Top(141,"Kayn","JUNGLE",145,"Kai'Sa","ADC",5,0,1062,562,0.53,TierData(2,8,8,7))],[Top(141,"Kayn","JUNGLE",555,"Pyke","SUPPORT",4,0,748,419,0.56,TierData(2,8,8,10)),Top(141,"Kayn","JUNGLE",111,"Nautilus","SUPPORT",2,0,925,515,0.56,TierData(2,6,6,5)),Top(141,"Kayn","JUNGLE",89,"Leona","SUPPORT",7,0,681,379,0.56,TierData(1,3,3,2))]),CoreItems([6697,6699,6696],["Hubris","Voltaic Cyclosword","Axiom Arc"],9500,5309,0.09),[],CoreItems([3158],["Ionian Boots of Lucidity"],48324,24810,0.39),CoreItems([1101,2003],["Scorchclaw Pup","Health Potion"],38217,19557,0.27),[CoreItems([6699],["Voltaic Cyclosword"],102577,53274,0.72),CoreItems([6697],["Hubris"],59241,30692,0.42),CoreItems([6696],["Axiom Arc"],44276,24546,0.31)],[CoreItems([3814],["Edge of Night"],11606,6834,0.17),CoreItems([6694],["Serylda's Grudge"],11223,6778,0.16),CoreItems([6333],["Death's Dance"],8834,5374,0.13)],[CoreItems([3026],["Guardian Angel"],5844,3945,0.21),CoreItems([3814],["Edge of Night"],3637,2211,0.13),CoreItems([6694],["Serylda's Grudge"],2689,1668,0.09)],[CoreItems([3142],["Youmuu's Ghostblade"],913,542,0.31),CoreItems([3026],["Guardian Angel"],628,400,0.21),CoreItems([6333],["Death's Dance"],166,80,0.06)],CoreItems([4,11],[4,11],138671,70538,0.97),Runes(8128,8100,"Domination",[8128,8143,8140,8135],["Dark Harvest","Sudden Impact","Grisly Mementos","Treasure Hunter"],8300,"Inspiration",[8304,8347],["Magical Footwear","Cosmic Insight"],[5008,5008,5001],[5008,5008,5001],40150,19827,0.28),Skills(["Q","E","W","Q","Q","R","Q","W","Q","W","R","W","W","E","E"],32778,19581,0.35),[SkillCombo("A + Q + A","https://www.youtube.com/watch?v=f5C9hcvrrv0"),SkillCombo("W + Flash","https://www.youtube.com/watch?v=-zzgpMIygPA"),SkillCombo("E Through walls Tip","https://www.youtube.com/watch?v=b7P8OAo4UBU"),SkillCombo("W + A + Q + A","https://www.youtube.com/watch?v=l8sihD2z7J4"),SkillCombo("Q + W + R + Q","https://www.youtube.com/watch?v=ZLL5bMKTN9k"),SkillCombo("Shadow assassin E + Flash + Q + R","https://www.youtube.com/watch?v=hbmAtJFLvfA"),SkillCombo("Flash+W+Q+A+R+A+Q+A+A","https://www.youtube.com/watch?v=WgkwFpp9igQ"),SkillCombo("E+W+Q+A+R+A+Q+A","https://www.youtube.com/watch?v=xoHdcm2AZd0")],SkillMasteries(["Q","W","E"],84805,50411,0.91,[Skills(["Q","E","W","Q","Q","R","Q","W","Q","W","R","W","W","E","E"],32778,19581,0.39),Skills(["Q","W","E","Q","Q","R","Q","W","Q","W","R","W","W","E","E"],23840,13948,0.28),Skills(["Q","E","Q","W","Q","R","Q","W","Q","W","R","W","W","E","E"],13560,8249,0.16),Skills(["Q","W","Q","E","Q","R","Q","W","Q","W","R","W","W","E","E"],3232,1912,0.04),Skills(["Q","E","W","Q","Q","R","Q","W","Q","W","W","R","W","E","E"],1350,800,0.02)]),Trends(173,63,Win("16.14",0.51,20,"2026-07-25T22:39:28+09:00"),Win("16.14",0.07,6,"2026-07-25T22:39:28+09:00"),Win("16.14",0.05,25,"2026-07-25T22:39:28+09:00"))))`;

/** Ahri support: real data, tiny sample (77 games). Pins that a low sample is
 *  carried through honestly rather than filtered or rounded away. */
export const AHRI_SUPPORT_LOW_SAMPLE = `class LolGetChampionAnalysis: champion,position,data
class Data: summary,damage_type,strong_counters,weak_counters,synergies,core_items,mythic_items,boots,starter_items,last_items,fourth_items,fifth_items,sixth_items,summoner_spells,runes,skills,skill_combos,skill_masteries,trends,counters_meta
class Summary: id,is_rotation,is_rip,average_stats,positions,roles
class AverageStats: play,win_rate,pick_rate,ban_rate,kda,tier,rank,tier_data
class TierData: tier,rank,rank_prev,rank_prev_patch
class Position: name,stats,roles,counters
class Stats: play,win_rate,pick_rate,role_rate,ban_rate,kda,tier_data
class Role: name,stats
class Stats1: win_rate,role_rate,play,win
class Counter: champion_id,champion_name,play,win
class Synergies: top,jungle,mid,adc
class Top: champion_id,champion_name,position,synergy_champion_id,synergy_champion_name,synergy_position,score_rank,score,play,win,win_rate,synergy_tier_data
class CoreItems: ids,ids_names,play,win,pick_rate
class Runes: id,primary_page_id,primary_page_name,primary_rune_ids,primary_rune_names,secondary_page_id,secondary_page_name,secondary_rune_ids,secondary_rune_names,stat_mod_ids,stat_mod_names,play,win,pick_rate
class Skills: order,play,win,pick_rate
class SkillCombo: name,video_url
class SkillMasteries: ids,play,win,pick_rate,builds
class Trends: total_rank,total_position_rank,win,pick,ban
class Win: version,rate,rank,created_at
class CountersMeta: message

LolGetChampionAnalysis("AHRI","SUPPORT",Data(Summary(103,false,false,AverageStats(200343,0.51,0.1,0.03,2.54,1,12,TierData(1,12,12,14)),[Position("MID",Stats(190917,0.51,0.09,0.95,0.03,2.55,TierData(1,2,2,3)),[Role("MAGE",Stats1(0.51,1,183926,94271))],[Counter(1,"Annie",2343,1120),Counter(238,"Zed",6164,3034),Counter(18,"Tristana",583,287)])],[]),"AP",[],[],Synergies([Top(103,"Ahri","SUPPORT",54,"Malphite","TOP",6,0,15,9,0.6,TierData(1,8,8,2)),Top(103,"Ahri","SUPPORT",41,"Gangplank","TOP",7,0,15,8,0.53,TierData(1,3,3,1)),Top(103,"Ahri","SUPPORT",58,"Renekton","TOP",10,0,11,5,0.45,TierData(2,12,12,21))],[Top(103,"Ahri","SUPPORT",5,"Xin Zhao","JUNGLE",10,0,12,7,0.58,TierData(3,15,16,21)),Top(103,"Ahri","SUPPORT",254,"Vi","JUNGLE",8,0,16,8,0.5,TierData(2,8,8,9)),Top(103,"Ahri","SUPPORT",64,"Lee Sin","JUNGLE",1,0,54,26,0.48,TierData(1,1,1,1))],[Top(103,"Ahri","SUPPORT",238,"Zed","MID",2,0,24,13,0.54,TierData(2,10,10,8)),Top(103,"Ahri","SUPPORT",517,"Sylas","MID",4,0,21,11,0.52,TierData(1,4,3,2)),Top(103,"Ahri","SUPPORT",777,"Yone","MID",1,0,24,12,0.5,TierData(2,22,22,29))],[Top(103,"Ahri","SUPPORT",236,"Lucian","ADC",9,0,16,10,0.63,TierData(3,10,10,10)),Top(103,"Ahri","SUPPORT",115,"Ziggs","ADC",4,0,26,16,0.62,TierData(1,2,2,9)),Top(103,"Ahri","SUPPORT",101,"Xerath","ADC",2,0,37,22,0.59,TierData(1,1,1,5))]),CoreItems([3118,4645,3157],["Malignance","Shadowflame","Zhonya's Hourglass"],30,15,0.04),[],CoreItems([3158],["Ionian Boots of Lucidity"],949,464,0.48),CoreItems([2003,2003],["Health Potion","Health Potion"],1922,904,0.95),[CoreItems([3871],["Zaz'Zak's Realmspike"],1623,748,0.76),CoreItems([3118],["Malignance"],1277,605,0.6),CoreItems([4645],["Shadowflame"],588,274,0.28)],[CoreItems([3157],["Zhonya's Hourglass"],44,32,0.2),CoreItems([3089],["Rabadon's Deathcap"],36,18,0.16),CoreItems([3165],["Morellonomicon"],28,15,0.12)],[CoreItems([3157],["Zhonya's Hourglass"],3,1,0.25),CoreItems([3089],["Rabadon's Deathcap"],3,3,0.25),CoreItems([3135],["Void Staff"],3,3,0.25)],[],CoreItems([4,14],[4,14],1561,742,0.73),Runes(8112,8100,"Domination",[8112,8139,8140,8106],["Electrocute","Taste of Blood","Grisly Mementos","Ultimate Hunter"],8200,"Sorcery",[8210,8226],["Transcendence","Manaflow Band"],[5005,5008,5001],[5005,5008,5001],691,304,0.32),Skills(["Q","E","W","Q","Q","R","Q","W","Q","W","R","W","W","E","E"],77,53,0.12),[SkillCombo("A + W + A","https://www.youtube.com/watch?v=P8nIVrnXo88"),SkillCombo("Q + Flash","https://www.youtube.com/watch?v=uern-Y1gR3A"),SkillCombo("E + Flash","https://www.youtube.com/watch?v=H3c3Kqd2beI"),SkillCombo("E + Q + W + A","https://www.youtube.com/watch?v=dgL1f8hVwPY"),SkillCombo("R+A+W+Q+E+A+R+A+R","https://www.youtube.com/watch?v=LtPRneOgI_0")],SkillMasteries(["Q","W","E"],380,219,0.61,[Skills(["Q","E","W","Q","Q","R","Q","W","Q","W","R","W","W","E","E"],77,53,0.2),Skills(["E","Q","W","Q","Q","R","Q","W","Q","W","R","W","W","E","E"],64,41,0.17),Skills(["W","E","Q","Q","Q","R","Q","W","Q","W","R","W","W","E","E"],63,33,0.17),Skills(["W","Q","E","Q","Q","R","Q","W","Q","W","R","W","W","E","E"],40,27,0.11),Skills(["E","W","Q","Q","Q","R","Q","W","Q","W","R","W","W","E","E"],25,11,0.07)]),Trends(173,49,Win("16.14",0,null,"2026-07-25T22:39:28+09:00"),Win("16.14",0,null,"2026-07-25T22:39:28+09:00"),Win("16.14",0,null,"2026-07-25T22:39:28+09:00")),CountersMeta("Insufficient matchup sample. See data.summary.positions[].counters[] for raw matchup data (smaller sample).")))`;

/** Unknown champion: HTTP 200 with a JSON-RPC error envelope. */
export const UNKNOWN_CHAMPION_ENVELOPE = `{"jsonrpc":"2.0","id":1,"error":{"code":-32603,"message":"Unknown champion provided."}}`;

/** Kha'Zix: his ultimate ranks carry EVOLUTION suffixes — the order contains
 *  literal "R-Q" and "R-W" tokens, not "R". Discovered by a full-roster sweep,
 *  2026-07-27; he is the only champion of 172 that does this. The parser
 *  rejects the whole payload rather than guessing at the token grammar. */
export const KHAZIX_JUNGLE = `class LolGetChampionAnalysis: champion,data
class Data: skills,skill_masteries
class Skills: order,pick_rate,play,win
class SkillMasteries: ids,pick_rate,play,win

LolGetChampionAnalysis("KHAZIX",Data(Skills(["Q","W","E","Q","Q","R-Q","Q","W","Q","W","W","R-W","W","E","E"],0.21,14443,8110),SkillMasteries(["Q","W","E"],0.85,59368,33935)))`;

/** Jinx: ranks the ultimate at levels 6 and TWELVE, not 6 and 11. Level 12 is
 *  not a legal ultimate level in a real game, which proves the published order
 *  is a per-level modal aggregate rather than one legal path. Her rank COUNTS
 *  are still standard, so her levels 16-18 remain derivable. */
export const JINX_ADC = `class LolGetChampionAnalysis: champion,data
class Data: skills,skill_masteries
class Skills: order,pick_rate,play,win
class SkillMasteries: ids,pick_rate,play,win

LolGetChampionAnalysis("JINX",Data(Skills(["Q","W","E","Q","Q","R","Q","W","Q","W","W","R","W","E","E"],0.39,39221,23437),SkillMasteries(["Q","W","E"],0.99,98562,59822)))`;

/** Jayce: transform champion, Q and W both reach SIX ranks and R is never
 *  ranked at all in the published 15. Refused on the cap check. */
export const JAYCE_TOP = `class LolGetChampionAnalysis: champion,data
class Data: skills,skill_masteries
class Skills: order,pick_rate,play,win
class SkillMasteries: ids,pick_rate,play,win

LolGetChampionAnalysis("JAYCE",Data(Skills(["Q","W","E","Q","Q","W","Q","W","Q","W","Q","W","W","E","E"],0.24,18585,9501),SkillMasteries(["Q","W","E"],0.89,67945,34997)))`;
