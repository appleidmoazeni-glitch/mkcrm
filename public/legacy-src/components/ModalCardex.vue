<template>
  <div class="modal fade" id="cardex" tabindex="-1" role="dialog" aria-hidden="true">
    <div class="modal-dialog modal-xl modal-dialog-centered" role="document">
      <div class="modal-content">
        <div class="modal-header">
          <h5 class="modal-title">کاردکس <span></span></h5>
          <button type="button" class="close" data-dismiss="modal" aria-label="بستن"><i class="ti-close"></i></button>
        </div>
        <div class="modal-body">
          <div class="table-responsive">
            <table class="table table-hover">
              <thead>
              <tr>
                <th>ردیف</th>
                <th>نوع فاکتور</th>
                <th>شماره ف</th>
                <th>تاریخ فاکتور</th>
                <th>تعداد/مقدار</th>
                <th>بهاء کالا</th>
                <th>مبلغ</th>
                <th>انبار</th>
              </tr>
              </thead>
              <tbody>
              <tr v-for="(c, index) of crdxdata">
                <td>{{ index+1 }}</td>
                <td>{{ statusTranslate(c.InvTyp) }}</td>
                <td>{{ c.InvNo }}</td>
                <td>{{ new Date(c.InvDate).echoFa("Y/m/d") }}</td>
                <td>{{ c.Quan }}</td>
                <td>{{ number_format(Math.trunc(c.Price)) }}</td>
                <td>{{ number_format(Math.trunc(c.Rial)) }}</td>
                <td>{{ c.STNumber }} - {{ c.StDesc }}</td>
              </tr>
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script>
import util from "../assets/pureFunctions";
import axios from "axios";

export default {
  name: "ModalCardex",
  data(){return {
    number_format: util.number_format,
    crdxdata: []
  }},
  methods: {
    statusTranslate(id){
      switch (id){
        case 2: return "فاکتور فروش";
        case 3: return "فاکتور خرید";
        case 5: return "رسید انبار";
        case 4: return "حواله انبار";
        case 6: return "برگشت از فروش";
        case 7: return "برگشت از خرید";
        default: return id;
      }
    }
  },
  mounted() {
    var vm = this;
    $('#cardex').on('show.bs.modal', function (event) {
      var el = $(event.relatedTarget),
          modal = $(this),
          itemid = el.attr('data-itemid');

      axios.post('https://shygun.4mk.ir/api/cardex/search', {id: itemid}).then(({data}) => {
        if( data && data.ok ){
          vm.crdxdata = data.list;

          vm.$nextTick(function () {
            setTimeout(function(){
              var ChatDiv = $('.modal-body');
              var height = ChatDiv[0].scrollHeight;
              ChatDiv.scrollTop(height);
            }, 100)
          });
        }else{
          toastr['error']("خطایی در فراخوانی داده ها رخ داده است.");
        }
      });
    });
  },
}
</script>

<style scoped>

</style>
