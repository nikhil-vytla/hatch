# GPU queue for the personality study (run in /tmp/q15 on a molab GPU notebook with HF_TOKEN set)
cd /tmp/q15; export PYTHONPATH=. PYTORCH_CUDA_ALLOC_CONF=expandable_segments:True
R=nikhilxvytla/neuron-atlas
python -u analysis/persona/weights.py --out pw --upload $R/Qwen__Qwen3-8B/persona/weights && echo "WEIGHTS DONE" || echo "WEIGHTS FAILED"
python -u analysis/persona/acts.py --out pa --upload $R/Qwen__Qwen3-8B/persona/acts && echo "ACTS DONE" || echo "ACTS FAILED"
python -u analysis/persona/write_trait.py --out pwr --acts pa/neurons.parquet --lexicon lexicon_j.json --upload $R/Qwen__Qwen3-8B/persona/write && echo "WRITE DONE" || echo "WRITE FAILED"
echo "PERSONA GPU DONE $(date)"
