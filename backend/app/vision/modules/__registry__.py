"""
Maps mode name string → analyzer class.
Add new modules here — nothing else needs to change.
"""
from app.sessions.models import AnalysisMode
from app.vision.modules.object_detector import ObjectDetector
from app.vision.modules.human_tracker import HumanTracker
from app.vision.modules.depth_mapper import DepthMapper
from app.vision.modules.person_tracker import PersonTracker
from app.vision.modules.enhancer import Enhancer

# Lazy import — only load heavy models when actually needed
ANALYZER_REGISTRY = {
    AnalysisMode.OBJECT_DETECT:  ObjectDetector,
    AnalysisMode.HUMAN_TRACKING: HumanTracker,
    AnalysisMode.DEPTH_MAPPING:  DepthMapper,
    AnalysisMode.PERSON_TRACK:   PersonTracker,
    AnalysisMode.ENHANCE:        Enhancer,
}