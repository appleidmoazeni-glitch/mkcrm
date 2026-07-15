<template>
    <button class="btn btn-primary" @click="increment">{{test.counter}}</button>
</template>
<script>
import {mapState} from 'vuex';
export default {
    computed: mapState(['test']),
    methods: {
        increment(){
            this.$store.state.test.counter++;
        }
    }
}
</script>