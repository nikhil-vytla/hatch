"""Quick test to verify Marimo compatibility."""
import sys
import os

# Add project root to path
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), '..')))

# Test basic import
try:
    from llabel import TextLabel
    print("✓ TextLabel import successful")
except Exception as e:
    print(f"✗ TextLabel import failed: {e}")
    sys.exit(1)

# Test widget creation
try:
    texts = [{"text": "Example 1"}, {"text": "Example 2"}, {"text": "Example 3"}]
    widget = TextLabel(
        examples=texts,
        render=lambda x: x["text"],
        notes=True
    )
    print("✓ TextLabel widget created successfully")
except Exception as e:
    print(f"✗ TextLabel creation failed: {e}")
    import traceback
    traceback.print_exc()
    sys.exit(1)

# Test with Marimo wrapper (simulated)
try:
    # Try to access the traits that were causing issues
    print(f"  - layout trait: {widget.layout}")
    print(f"  - comm trait: {widget.comm}")
    print("✓ Trait access successful (layout and comm)")
except Exception as e:
    print(f"✗ Trait access failed: {e}")
    import traceback
    traceback.print_exc()
    sys.exit(1)

# Test annotation methods
try:
    annotations = widget.get_annotations()
    progress = widget.progress()
    print(f"✓ Methods work - {len(annotations)} annotations, {progress['percent']}% progress")
except Exception as e:
    print(f"✗ Method calls failed: {e}")
    import traceback
    traceback.print_exc()
    sys.exit(1)

print("\n✓ All compatibility tests passed!")
print("\nNote: For full Marimo integration, use:")
print("  import marimo as mo")
print("  widget = mo.ui.anywidget(TextLabel(examples=texts))")
print("  widget.value.get_annotations()  # Access methods via .value")
