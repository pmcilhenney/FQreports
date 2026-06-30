import unittest
import xml.etree.ElementTree as ET

from flexiquiz_to_moodle import ConvertOptions, convert_questions


class ConverterTests(unittest.TestCase):
    def test_radio_button_converts_to_single_multichoice(self):
        xml, warnings = convert_questions(
            [
                {
                    "question_id": "q1",
                    "type": "radio_button",
                    "text": "What is the minimum oxygen cylinder pressure before leaving?",
                    "points_available": 1,
                    "options": [
                        {"text": "200 psi", "correct": False},
                        {"text": "500 psi", "correct": True},
                    ],
                    "categories": [{"name": "Operations"}],
                }
            ],
            ConvertOptions(category="EMS Academy/Ops"),
        )

        self.assertEqual(warnings, [])
        root = ET.fromstring(xml)
        questions = root.findall("question")
        self.assertEqual(questions[1].attrib["type"], "multichoice")
        self.assertEqual(
            questions[1].findtext("name/text"),
            "What is the minimum oxygen cylinder pressure before leaving?",
        )
        self.assertEqual(questions[1].findtext("single"), "true")
        answers = questions[1].findall("answer")
        self.assertEqual(answers[1].attrib["fraction"], "100")

    def test_checkbox_splits_credit_and_penalizes_wrong_answers(self):
        xml, warnings = convert_questions(
            [
                {
                    "question_id": "q2",
                    "type": "checkbox",
                    "text": "Select the BSI items.",
                    "options": [
                        {"text": "Gloves", "correct": True},
                        {"text": "Eye protection", "correct": True},
                        {"text": "Coffee", "correct": False},
                        {"text": "Radio strap", "correct": False},
                    ],
                }
            ],
            ConvertOptions(),
        )

        self.assertEqual(warnings, [])
        root = ET.fromstring(xml)
        question = root.find("question")
        self.assertEqual(question.findtext("single"), "false")
        fractions = [answer.attrib["fraction"] for answer in question.findall("answer")]
        self.assertEqual(fractions, ["50", "50", "-50", "-50"])

    def test_true_false_converts_to_truefalse_type(self):
        xml, warnings = convert_questions(
            [
                {
                    "question_id": "q3",
                    "type": "radio_button",
                    "text": "Scene safety is dynamic.",
                    "options": [
                        {"text": "True", "correct": True},
                        {"text": "False", "correct": False},
                    ],
                }
            ],
            ConvertOptions(),
        )

        self.assertEqual(warnings, [])
        root = ET.fromstring(xml)
        question = root.find("question")
        self.assertEqual(question.attrib["type"], "truefalse")

    def test_skip_unsupported_skips_image_only_choices(self):
        xml, warnings = convert_questions(
            [
                {
                    "question_id": "q4",
                    "type": "picture_choice",
                    "text": "Which trailer may contain pressurized gas?",
                    "options": [
                        {"image_url": "https://example.test/a.png", "correct": True},
                        {"image_url": "https://example.test/b.png", "correct": False},
                    ],
                },
                {
                    "question_id": "q5",
                    "type": "radio_button",
                    "text": "Scene safety starts before arrival.",
                    "options": [
                        {"text": "True", "correct": True},
                        {"text": "False", "correct": False},
                    ],
                },
            ],
            ConvertOptions(skip_unsupported=True),
        )

        root = ET.fromstring(xml)
        real_questions = [question for question in root.findall("question") if question.attrib.get("type") != "category"]
        self.assertEqual(len(real_questions), 1)
        self.assertEqual(real_questions[0].findtext("name/text"), "Scene safety starts before arrival.")
        self.assertEqual(len(warnings), 1)
        self.assertIn("Image-only answer choices", warnings[0])


if __name__ == "__main__":
    unittest.main()
